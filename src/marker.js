// The on-page half of Web Marker: links pointing at a page you have marked
// unread glow blue, and links to pages you have already read can be faded, so
// what stands out on a page is what you haven't got to yet. Nothing is added to
// the page — no dot, no badge, only a class on links already there — and the
// script is read-only besides: it can never change a status, so a mistimed click
// on a busy page can't quietly rewrite your marks. Marking is the popup's job.
// The marker is **per site** and off until this site's toggle in the popup is
// on — while off this script only watches that site's flag and touches nothing.
//
// Everything goes through the service worker: this script sends URLs and gets
// back state, so `urlKey()` in common.js stays the only definition of "the same
// page" — and the same for which site this is, which decides the storage key
// below. Content scripts can't import ES modules, so the appearance key is
// mirrored literally from common.js.

const READ_OPACITY_KEY = 'app:readOpacity'

/**
 * One entry per status the page shows. `link` tags a link with that status. Its
 * opacity goes through `variable` on the page root and is armed by `dim` there,
 * only below 100% — see `setOpacity()` and ../styles/marker.css. `fade` is how
 * much of the Read link opacity setting's fade the status takes: unread links
 * fade half as far as read ones, so they dim with the page without ever sinking
 * to where read links sit.
 */
const STATUSES = {
  read: {
    link: 'wmk-read-link',
    variable: '--wmk-read-opacity',
    dim: 'wmk-dim-read',
    fade: 1,
  },
  unread: {
    link: 'wmk-unread-link',
    variable: '--wmk-unread-opacity',
    dim: 'wmk-dim-unread',
    fade: 0.5,
  },
}
const MARKED = Object.values(STATUSES)
const SCAN_DELAY_MS = 300
const CHUNK = 400

let enabled = false
/** This site's switch, named by the worker on startup — see the bottom of the file. */
let annotateKey = null
let observer = null
let timer = null
let orphaned = false // the extension was reloaded out from under this script
/**
 * The href each link was last looked up as. A single-page app routes by handing
 * an anchor already on screen a new href rather than building a new link, so
 * "already looked at" has to mean "looked at pointing there" — otherwise a
 * recycled link keeps the mark of the page it used to point to for as long as
 * the tab is open.
 *
 * A WeakMap rather than an attribute on the link: the page carries nothing of
 * ours, and a link the framework drops takes its entry with it.
 */
let checked = new WeakMap()
/** The URL the marks on screen were resolved for — see scan(). */
let scannedAt = null

/**
 * Reloading or updating the extension leaves the content scripts already
 * injected into open tabs without a runtime to talk to. `sendMessage` then
 * throws **synchronously** — a `.catch()` on its result never sees it, so it
 * surfaces as an uncaught rejection in whichever async caller we were in
 * (typically `scan()`, once per mutation, which on a page like YouTube is a
 * lot).
 *
 * An orphaned script can never recover — only a page reload brings one back —
 * so the only sane response is to stop and leave the page as we found it.
 */
function send(message) {
  if (orphaned) return Promise.resolve(null)
  try {
    return chrome.runtime.sendMessage(message).catch(() => null)
  } catch {
    teardown()
    return Promise.resolve(null)
  }
}

function stopTimer() {
  clearTimeout(timer)
  timer = null
}

/** Give up: stop watching, and undo everything we did to the page. */
function teardown() {
  orphaned = true
  enabled = false
  observer?.disconnect()
  observer = null
  stopTimer()
  clearMarks()
  clearStyling()
}

/**
 * Mirrors clampSetting() in common.js. Empty values are checked before
 * `Number()` sees them: it turns `null` and `''` into 0, which would clamp an
 * unset setting to the faintest links rather than leaving it at the default.
 */
function clampSetting(value, min, max, fallback) {
  const empty = value === null || value === undefined || value === ''
  const number = empty ? NaN : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

/**
 * How faded marked links are. The setting is stored as a whole percentage (see
 * common.js) and each status takes its `fade` share of the distance below 100;
 * CSS wants the 0–1 fraction. It's set as a custom property on the page root
 * rather than on each link, so the links themselves are tagged once and never
 * touched again when the setting changes — no rescan, nothing in the DOM to
 * revisit.
 */
function setOpacity(value) {
  const percent = clampSetting(value, 20, 100, 100)
  const root = document.documentElement
  for (const status of MARKED) {
    const opacity = 100 - (100 - percent) * status.fade
    root.style.setProperty(status.variable, String(opacity / 100))
    // The class is what arms the `!important` rule, so at 100% we match nothing
    // and a site that fades its own visited links keeps doing exactly that.
    root.classList.toggle(status.dim, percent < 100)
  }
}

/** The appearance settings, read together and applied together. */
const STYLE_KEYS = [READ_OPACITY_KEY]

function applyStyling(stored) {
  setOpacity(stored[READ_OPACITY_KEY])
}

/**
 * A link is only touched when it points at a page marked read or unread. Whether
 * it's a favourite is the popup's to say, and saying nothing about an unmarked
 * page leaves that link exactly as its own site styled it.
 *
 * Tagged even at full opacity: the root variable does the fading, so the setting
 * can change without every link having to be visited again.
 *
 * Any previous status comes off first: the link may be one the page has just
 * pointed somewhere else, and the page it points at now may be unmarked.
 */
function markLink(link, state) {
  for (const status of MARKED) link.classList.remove(status.link)
  const status = state && STATUSES[state.status]
  if (status) link.classList.add(status.link)
}

/**
 * Links not looked up as they stand, ignoring anything that isn't a plain web
 * link. A link whose href has changed since we resolved it counts as new.
 */
function candidates() {
  const out = []
  for (const link of document.links) {
    if (!/^https?:$/i.test(link.protocol)) continue
    if (checked.get(link) === link.href) continue
    out.push(link)
  }
  return out
}

async function scan() {
  if (!enabled) return
  // A route change in a single-page app leaves everything on screen in place,
  // including anchors now pointing at other pages, so once the URL moves every
  // mark is suspect and the whole document is looked at again. The document
  // never reloaded, which is the only reason this script is still here to ask.
  if (location.href !== scannedAt) {
    scannedAt = location.href
    clearMarks()
  }
  const links = candidates()
  if (!links.length) return

  for (let start = 0; start < links.length; start += CHUNK) {
    const batch = links.slice(start, start + CHUNK)
    const states = await send({ type: 'checkLinks', urls: batch.map((link) => link.href) })
    if (!Array.isArray(states) || !enabled) return
    batch.forEach((link, i) => {
      // Recorded against the href we asked about, so a later swap re-qualifies.
      checked.set(link, link.href)
      markLink(link, states[i])
    })
  }
}

/**
 * Throttled, not debounced: an app that mutates the DOM continuously — a live
 * feed, a video's own controls — pushed a debounce's deadline back with every
 * mutation and the scan never came. The first mutation of a burst books the
 * scan and the rest ride along with it, so marks land within SCAN_DELAY_MS of
 * the page changing however busy the page stays.
 */
function schedule() {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    scan()
  }, SCAN_DELAY_MS)
}

function clearMarks() {
  for (const { link } of MARKED) {
    for (const el of document.querySelectorAll(`.${link}`)) el.classList.remove(link)
  }
  checked = new WeakMap() // every link is a candidate again
}

/**
 * The opacities are settings, not marks, so they survive the clear-and-rescan
 * that follows every change to the store. Removing them there meant marking any
 * page silently reset every faded link on screen to the default. Which links are
 * read or unread is a mark, though, so those classes go with `clearMarks()`.
 */
function clearStyling() {
  const root = document.documentElement
  for (const status of MARKED) {
    root.style.removeProperty(status.variable)
    root.classList.remove(status.dim)
  }
}

function setEnabled(next) {
  if (orphaned || next === enabled) return
  enabled = next
  if (enabled) {
    // Turning the marker on mid-session needs the current value too.
    chrome.storage.local.get(STYLE_KEYS).then(applyStyling, () => {})
    observer ??= new MutationObserver(schedule)
    // `href` is watched as well as new nodes: a framework re-pointing a link it
    // has already rendered changes nothing but that attribute, and that link
    // now describes a different page.
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    })
    schedule()
  } else {
    observer?.disconnect()
    stopTimer()
    clearMarks()
    clearStyling()
  }
}

// A mark changed somewhere — re-evaluate every link, not just new ones, since a
// link styled as read or unread may be neither any more.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'refreshMarks' && enabled) {
    clearMarks()
    schedule()
  }
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (enabled && changes[READ_OPACITY_KEY]) setOpacity(changes[READ_OPACITY_KEY].newValue)
  // One key, this site's — a toggle on some other site changes a key we never
  // look at, so nothing here reacts to it.
  if (annotateKey && changes[annotateKey]) setEnabled(!!changes[annotateKey].newValue)
})

// Ask the worker which site this is: it replies with the key holding this site's
// switch and whether it's on. A page with no site to speak of (there is none
// here, since the script only runs on http(s)) gets a null key, and then nothing
// can ever turn the marker on — which is the right answer for a page that can't
// be marked either. `setEnabled()` reads the appearance settings itself.
//
// `send()` already survives the synchronous throw of an orphaned context; the
// catch covers a `chrome.*` that is gone entirely.
try {
  send({ type: 'siteAnnotate', url: location.href }).then((reply) => {
    if (!reply) return
    annotateKey = reply.key
    setEnabled(!!reply.enabled)
  })
} catch {
  teardown()
}
