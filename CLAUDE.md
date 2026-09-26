# Web Marker — how it works

The design and the rules the code keeps. [`README.md`](README.md) is the pitch. Read this
before changing anything.

## Working on it

- **No build, no deps, no tests.** `package.json` only marks the source as ES modules for
  node (handy for importing `common.js` in a throwaway script); Chrome ignores it.
- **Verify in the browser** — it's the only check there is. Reload the extension _and_ the
  tab: a reload orphans content scripts already injected (see [Limitations](#limitations)).
- **Formatting:** root `.prettierrc` — no semicolons, single quotes, 2-space indent, 100 cols.
- **`marker.js` can't import ES modules**, so it mirrors constants from `common.js`
  literally (`app:readOpacity`, the 20–100 clamp, the clamp helper). Change one, change the
  other — nothing enforces it. Its own site's key is *not* mirrored; it asks the worker,
  since deriving it needs `registrableDomain()`.

## Model

- Marks are per **page URL** (`urlKey()`), never per site. The popup groups by site to
  answer "what have I marked here".
- A page has a **read state** (`unread` / `read` / neither) and, separately, a **★
  favourite** flag. They're orthogonal: starring never changes read state, and a page can be
  starred with no read state at all.
- An entry is created when you mark a page and **deleted once it has neither a read state
  nor a star** — the store is exactly the pages you cared about. Visiting records nothing;
  no history tracking.

## UI rules

**Toolbar icon** — the state of the page you're on, and the whole signal: blue = unread,
grey = read, **gold ring** = favourite, hollow ring = unmarked. No badge, no count.

**Popup.** Top row is the current page: title, state dot, buttons.

| Button | When |
| --- | --- |
| read-state toggle | always; unmarked → `unread`, then flips unread ↔ read |
| mark read | only while unmarked — "I've already read this" shouldn't cost a trip through unread |
| ★ | always; separate question, so `read · favorite` is reachable |
| forget | only once marked; one click, no confirm — it only touches the page in front of you |

Below: `Unread` / `Read` / `★` tabs listing the current site's pages, oldest first. Rows
under Unread/Read carry flip-state + star; rows under ★ carry only unstar (read state is
whatever the other tabs show). **Rows can't delete** — a crowded list is the wrong place for
it. Nothing in the popup returns a page to unmarked except *forget*; bulk removal is the
manage page's job.

The header's leftmost button is **the on-page marker's switch for this site** — lit while
links here are styled. It's the one control about the site rather than a page, which is why
it sits by the site's name.

**Manage** (header button) → two tabs. **Saved pages**: everything, grouped by site, with
filters, search and bulk actions. **Settings**: the knobs that aren't about any one page.
They used to be one scroll, which put a wall of settings between the header and the list.
Export/Import stay in the header above both — they're the whole store, not either half.
Switching tabs leaves the hidden half's DOM alone, so a filter, search and selection survive
a trip to settings and back.

**Service worker** — keeps the icon in sync and answers the content script. Fully
event-driven (tab events, `chrome.storage.onChanged`, an `entriesChanged` runtime message);
no polling, no alarms. Icons are **drawn at runtime** with `OffscreenCanvas`: six
combinations, and generating them keeps the colours defined once.

## Storage

Split by what watches it:

- **Entries → IndexedDB.** Database `site-marker`, store `entries`, keyed by `urlKey()`,
  indexed on `domain`, `host`, `addedAt`. One record per page, so a mark writes one record
  instead of rewriting the store. Plumbing lives only in [`db.js`](src/db.js); everything
  else goes through the store functions in [`common.js`](src/common.js).
- **Settings → `chrome.storage.local`**, every key prefixed **`app:`** (`app:readOpacity`,
  plus one `app:annotate:<site>` per site the marker is on for). They stay there because
  they're exactly the keys live things *watch* via `chrome.storage.onChanged`. IndexedDB has
  no change events, so moving a handful of tiny values would mean rebuilding that plumbing
  for nothing.

IndexedDB's silence is covered the other way round: after every successful entry write the
writer sends an **`entriesChanged`** runtime message, and the worker repaints every tab's
icon and tells content scripts to re-check. `sendMessage` wakes a stopped worker — which the
storage event used to do for free and a `BroadcastChannel` would not.

Batch writes are **one transaction**: an import with Replace commits whole or not at all. A
write that fails (quota, full disk) **rejects rather than silently dropping data** — the
transaction aborts and the caller sees `StorageFullError`. Deletes never need space, so
there is always a way back.

State is local, not `chrome.storage.sync` — sync caps at 100 KB / 8 KB per item / 512 items.
Export/import is the cross-device path.

**Capacity.** `unlimitedStorage` lifts IndexedDB's quota; what's left is the disk. An entry
averages ~350 bytes, so a decade of heavy marking is megabytes. The manage page shows an
approximate size (marked **≈** — `navigator.storage.estimate()` is origin-wide and
approximate, the only size IndexedDB admits to). The popup reads only the current site
through the `domain`/`host` index (`getSiteEntries()`), so growth doesn't slow it down; only
the manage page loads everything, which is its job.

**The database is still called `site-marker`**, from when the extension was. An IndexedDB
name is the address of the data: renaming it opens a new, empty database and strands every
mark in the old one, so it stays. Same story twice over — the removed folder-sync feature
used a `site-marker` database too, so `db.js` deletes whatever stores it finds when upgrading
to its own schema (v2). The old `chrome.storage.local` → IndexedDB migration is gone; a
profile that never ran a build with it just starts empty.

## The on-page marker

[`marker.js`](src/marker.js) runs on every `http(s)` page but is **inert until you turn it
on for that site**; while off it only listens for that site's flag and touches nothing.

**Per site, every site off by default.** The marker answers "have I been here before" on
sites where you actually collect pages; elsewhere it's a change to someone else's page for
no reason, and a global switch made the second group pay for the first. A site is on while
`app:annotate:<site>` exists; off deletes the key, so the store holds exactly the sites you
said yes to. The site is `siteKey()` — under the default `MATCH: 'domain'`, turning it on for
`docs.example.com` turns it on for `example.com` and every sibling subdomain.

**Only the popup turns a site on**, because it's the only place that knows which site you
mean. Manage → Settings → **On-page marker** lists the sites it's on for as chips; clicking
one turns it off — review and undo from anywhere, without a text box for typing a domain in
slightly wrong.

When on, it styles **every link pointing at a page you've marked**: unread links glow blue
(the icon's unread blue), read links can be faded. Unmarked links are untouched. A debounced
`MutationObserver` (300 ms, 400 links per lookup) catches links added later; any store change
re-marks open pages immediately.

- **Nothing is added to the page.** An earlier build put a dot inside each marked link; on
  dense pages the dots covered neighbouring links, and anything inside a link is part of
  someone else's layout. Everything is now a property on the link itself — `filter` and
  `opacity` take no space and draw nowhere a click lands.
- **The glow is a `drop-shadow`**, not a colour filter: `sepia`/`hue-rotate` only rework the
  colour already there, so black or white link text — most links on most pages — would come
  out unchanged. It bleeds a pixel or two past the link, visually only. Not a setting: it is
  the marker being on.
- **Favourite is deliberately not shown on the page.** The icon and popup answer "what is
  this page"; the page only answers "have I got to this yet".
- **Read link opacity** is the one appearance setting, on Manage → Settings, and **global** —
  it's how marked links look wherever the marker is on. 20–100%, default 100 (a true no-op).
  Floor is 20 because this fades the page's own text. Stored as a whole percentage, not a
  0–1 fraction, which keeps the slider and clamp on integers.
- **Unread links take half the fade**: `100 − (100 − setting) / 2`. At 40%, read sits at 40
  and unread at 70. Not a setting of its own — the order that matters (unread never fainter
  than read) holds at every slider position, and a second slider would only let them cross.
  The ratio is the `fade` share per status in the `STATUSES` table in `marker.js`, which also
  holds each status's class, CSS variable and gate.
- Both opacities are **custom properties on the page root**, so dragging the slider restyles
  every marked link in every open tab at once — no rescan, nothing in the DOM retouched.
  Links are tagged `.wmk-read-link` / `.wmk-unread-link` whatever the setting says.
- **`!important` throughout**: a site's own link rule beats a single class of ours easily,
  and without it the marker would silently do nothing on most pages. Each opacity is
  additionally gated behind a root class (`.wmk-dim-read` / `.wmk-dim-unread`) added only
  below 100%, so at the default the rule matches nothing at all.
- The setting was once `app:readLinkOpacity` holding a 0–1 fraction. The new name means a
  stale `0.5` can never be read as half a percent.

**Read-only by construction.** The content script adds a class and nothing else; the worker
accepts `checkLinks` and `siteAnnotate` and **no write messages at all**, so nothing running
in a page can change a status. Normalisation lives **only** in the worker — the content
script sends hrefs and gets back state — so there is one definition of "the same page".

Because the script is declared for `http://*/*` and `https://*/*`, Brave asks for read
access to all sites at install time.

## Bulk actions (manage page)

Sites start **collapsed** — the page opens as a list of sites and counts, not a wall of
pages. Clicking a site opens it; a text search opens whatever it matched (a search that hides
its own results would be useless), while filter chips only narrow and leave sites closed.

Every row has a checkbox; each site heading has one for the whole group (half-ticked when
partially selected), and it works whether the site is open or not. **Rows carry no buttons** —
one page is just a selection of one, and a long list is the wrong place for a delete button
you can hit by accident. With anything selected the bar above turns on: **Unread**, **Read**,
**★ Favorite**, **Unfavorite**, **Delete**.

Two rules keep it honest:

- **The selection is always what's on screen.** Changing filter or search clears it, so an
  action can never reach a row you can't see. The bar states the count outright.
- **Unfavorite warns before it deletes.** A favourite with no read state has nothing left
  once the star is gone, so it disappears (same rule as a single unstar). If any selected rows
  are in that position, it says how many and asks first.

However many rows, a bulk change is **one read and one write** (`updateEntries`).

## Export format

**Export** downloads the whole store as `web-marker-<YYYY-MM-DD>.ndjson`
([NDJSON](https://github.com/ndjson/ndjson-spec)): a header line, then one line per entry in
URL-key order.

```
{"format":"web-marker","version":4,"exportedAt":"2026-08-12T09:12:33.401Z","counts":{"sites":12,"total":84,"unread":30,"read":54,"favorite":9}}
{"url":"https://example.com/article","title":"Some article","status":"unread","favorite":true,"addedAt":"2026-05-02T18:20:00.000Z","updatedAt":"2026-06-11T07:03:12.000Z"}
{"url":"https://example.com/other","title":"Another","status":"read","addedAt":"2026-05-04T10:00:00.000Z","updatedAt":"2026-05-09T21:14:02.000Z"}
```

One entry per line is chosen for git: commit an export and a newly marked page is a one-line
insertion, with none of the array reshuffling (or trailing-comma edits) JSON would force.
`favorite` is omitted when false — it would be noise on almost every line, so the second
entry above isn't starred. `addedAt` is first marked, `updatedAt` last changed; there are no
per-status timestamps. `host`/`domain` are derived from the URL and left out. A title with a
newline, tab or quote is safe — `JSON.stringify` escapes it, so one entry is always one line.

**Import** matches on URL, merges newest-`updatedAt`-wins, and offers Replace as an explicit
choice. Accepted shapes:

| Shape | Note |
| --- | --- |
| v4 (current) | header line + entries |
| v3 | favourite was briefly a status; those entries become starred with no read state |
| v2 | already had the flag; survives whole |
| v1 | one JSON object with an `entries` array |
| headerless NDJSON | entry lines only — the per-site shards the short-lived folder-sync wrote, so they aren't stranded |

A header saying `"format":"site-marker"` is also read: that's what exports written before the
rename carry, and they're otherwise identical files (`LEGACY_FORMATS` in `common.js`). The
rename was ours to make, so it isn't an export's problem.

Another tool's export is **not** accepted, however close it looks — `parseExport()` throws a
readable message instead. Quietly guessing at someone else's shape is how you import
nonsense. Converting such a file is a throwaway script's job, and one that builds its output
with the extension's own `exportText()` so it can't drift from the current format.

Two URLs are the same page when they agree after dropping the `#` fragment, a leading `www.`
and a trailing slash (`urlKey()`). The query string still counts; the path stays
case-sensitive.

## Tuning

`CONFIG` at the top of [`common.js`](src/common.js):

- `MATCH` (default `'domain'`) — `'domain'` treats `docs.example.com` and `example.com` as
  one site; `'host'` requires an exact hostname. A leading `www.` is ignored either way.
- `SORT` (default `'oldest'`) — popup list order by when a page was first marked.

The glow colour and fades are in [`marker.css`](styles/marker.css); the icon colours are the
`ICON` block in [`background.js`](src/background.js). **Keep the glow's blue in step with the
icon's unread fill** (`#2f6fed`). The marker's per-site switch is storage, not a `CONFIG`
knob — though `MATCH` decides what counts as one site there too.

## Limitations

- **`http(s)` only.** On `brave://`, `file://` or the new tab page there's nothing to mark,
  and the popup says so.
- **Nothing leaves the browser on its own.** No file or cloud copy — export before wiping a
  profile.
- **`unlimitedStorage` lifts the quota, not physics.** A full disk still fails the write,
  loudly.
- **Domain detection is a short suffix list.** `registrableDomain()` knows common two-label
  suffixes (`co.uk`, `com.au`, `co.th`, …) and otherwise assumes the last two labels. Not the
  full Public Suffix List — add an entry if a site you use groups wrongly.
- **Titles are captured when you mark** and refreshed on re-marking; they don't follow a
  page's later title change.
- **A field-level change rewrites a whole export line.** That's NDJSON's trade for clean
  one-line insertions; `git diff --word-diff` shows the field that moved.
- **The marker is whole-URL, not per-site.** A link is styled only if that exact page is
  marked; the popup's looser domain matching doesn't apply.
- **The marker skips iframes** and any href that isn't `http(s)`.
- **A site rule can still win.** Ours is `!important`, which clears the ordinary case, but a
  site rule that's also `!important` and more specific beats it — and on a link the site
  already renders faded, the setting has nothing visible left to do.
- **The glow can be clipped** by a container with `overflow: hidden` hugging the link, and it
  makes the link a stacking context, which can occasionally reorder a dropdown or
  `position: fixed` element nested inside one.
- **Reloading the extension orphans the marker in open tabs.** Chrome gives those content
  scripts no runtime, and `chrome.*` calls throw synchronously (`Extension context
  invalidated`). `marker.js` detects this and tears itself down — styling removed, observers
  disconnected — rather than throwing on every mutation. **Reload the tab.** Development
  only; a normal session never sees it.

## Files

```
manifest.json     # MV3; the only file naming paths, so it points at all three folders
package.json      # marks the source as ES modules for anything run under node
src/
  common.js       # CONFIG, URL normalisation, the entry store, export/import
  db.js           # IndexedDB plumbing — the only file touching the API
  background.js   # toolbar icon per page state, link lookups, which site a tab is on
  marker.js       # read-only styling of links to read and unread pages
  popup.js        # current-page controls, per-site tabs and list
  manage.js       # tabs, grouping, filtering, bulk actions, file drop/pick
  icons.js        # inline SVG icons for the buttons
views/
  popup.html      # popup markup
  manage.html     # two tabs — the all-sites list and filters, and the settings
styles/
  marker.css      # the unread glow and both fades, injected into every page
  ui.css          # both views, light + dark
```

Paths cross a folder boundary in exactly four places, all declarations rather than logic:
`manifest.json`, the `<link>`/`<script>` at the top of each view, and
`getURL('views/manage.html')` in [`popup.js`](src/popup.js). Everything else is a sibling
import — `src/` only ever imports from `src/`.
