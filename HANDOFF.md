# BP Log — Project Handoff

Blood pressure tracking PWA. Local-first, offline-capable, no backend.

- **Repo:** https://github.com/finsen98614-afk/bp-log (public, required for free GitHub Pages)
- **Live:** https://finsen98614-afk.github.io/bp-log/
- **Owner:** Finsen (GitHub `finsen98614-afk`, email `finsen98614@gmail.com`)
- **Device:** Redmi 14 Pro, Android, Chrome. Installed as a PWA from the app drawer.
- **Current version:** service worker cache `bp-log-v17`
- **Tests:** 203 checks (194 app + 9 service worker) — `npm install && npm test`

---

## Why this architecture

Read this before proposing a redesign — three earlier approaches were tried and abandoned for concrete reasons.

| Attempt | Why it failed |
|---|---|
| Claude.ai artifact + `window.storage` | The storage bridge in the Claude mobile app webview returns `unexpected response type`. Host-level bug, unfixable from artifact code. Data silently never persisted. |
| Google Sheets + Apps Script proxy | Works, but artifact iframe CSP may block `fetch` to `script.google.com`, and it needs a deploy step plus network access on every write. |
| **PWA on GitHub Pages (current)** | IndexedDB in a real browser is reliable. No server, no auth, no network dependency. |

**The lesson that shaped the code:** the original failure was optimistic UI — the screen showed "saved" while the write had failed. Every write path now `await`s the storage operation *before* updating the UI. If a write throws, the user sees an error and no row appears. Do not reintroduce optimistic updates.

---

## Files

Everything lives at repo root. Flat structure — GitHub Pages serves from `/`.

```
index.html      ~34 KB   entire app: markup, CSS, and JS in one file
sw.js                    service worker: network-first shell, cache-first assets
manifest.json            PWA manifest, relative paths so any repo name works
icon-192.png             app icon, declared both any and maskable
icon-512.png             same, larger
icon.svg                 the source the two PNGs were rendered from
acceptance.js            app test suite (not deployed; keep in repo for CI/local runs)
sw.test.js               service worker tests, run by the same `npm test`
package.json             declares the two test dependencies and `npm test`
package-lock.json        pins them, so a fresh clone tests against what shipped
.gitignore               keeps node_modules out of the deployed root
HANDOFF.md               this file
```

Single-file design is deliberate: no build step, no bundler, no dependencies. Editing means opening one file. Keep it that way unless there's a strong reason.

**The icon** is an aneroid gauge — the sign for blood pressure — with the app's own
severity ramp as the dial face. It replaced a bar chart, which said "statistics",
not "blood pressure". `icon.svg` is the source; the PNGs were rendered from it once
with `sharp` and committed. That render is not part of the build — there is no
build — so if you change the SVG, re-render the two PNGs by whatever means and
commit them too.

It is full bleed on purpose. The manifest declares these maskable, so the launcher
applies its own shape; art with rounding already baked in gets clipped into a
smaller square. Everything meaningful sits within 173px of centre on the 512 grid,
inside the 205px maskable safe zone.

---

## Data model

IndexedDB database `bpLogDB`, version 1, object store `readings`, `keyPath: 'id'`.

A reading:

```js
{
  id:    1757049600000,        // ms timestamp, monotonic, safe integer
  date:  '2026-09-05 09:07',   // local time string, sorts lexicographically
  sys:   124,                  // integer 40–260
  dia:   79,                   // integer 20–200
  pulse: 70,                   // integer 25–250, or null
  note:  '啱啱飲完咖啡'          // string capped at 200 chars, or null
}
```

**Reserved negative ids** — records with `meta: true`, filtered out of `entries` on load:

| id | Purpose |
|---|---|
| `-1` | `META_ID` — legacy backup-date record from a removed feature. Kept only so old installs don't render it as a reading. |
| `-2` | `SETTINGS_ID` — `{guideline: 'ca' \| 'intl'}` |

`normalize()` re-keys any incoming record claiming `-1` or `-2`, so a hand-edited backup can't clobber settings.

**Category is never stored.** It's computed at display time from the active guideline. This is what makes guideline switching relabel all history instantly without touching stored numbers.

---

## Key invariants — do not break these

1. **Write before render.** `await dbPut(...)` succeeds before the row appears. See `onAdd()`.
2. **`normalize()` is the gatekeeper.** Returns `null` for anything untrustworthy; every caller must `.filter(Boolean)`. NaN must never reach the DB, the stats, or the chart. `date` is validated too — both its shape and that it actually parses, since `2026-13-45 99:99` satisfies the pattern.
3. **A failed read must not trigger a write.** If `openDB()` throws, `entries` is empty and **every control that writes** is disabled — Add *and* Restore — so an empty array can never overwrite real stored data. This originally named only Add; Restore writes as well, and left enabled it reached `dbPutMany` with `db` null.
4. **Exports use `entries`, never the rendered window.** CSV, backup, and the printed report must cover every reading even when only 50 rows are on screen.
5. **Ids stay safe integers.** An earlier scheme multiplied a ms epoch by a stride, exceeded `Number.MAX_SAFE_INTEGER`, lost precision, and produced collisions. `newId()` now returns a monotonic timestamp, seeded from the largest id already stored and from any restored backup.
6. **Whole numbers only on input.** `parseInt('124.7')` silently yields `124` — a reading the user never took. Input uses `/^\d+$/`.
7. **Colour means one thing.** The green→amber→orange→red ramp grades blood
   pressure and nothing else. Structure — section labels, focus rings, the entry
   card's edge — uses `--accent`, a cool blue chosen because it has no place on
   that ramp. Never decorate with a severity colour, and never grade with the
   accent. Fill depth carries hierarchy instead: `--panel-low` for reference
   material, `--panel` for ordinary cards, `--card` for the entry card.
8. **Edit these files with a UTF-8-aware tool.** Windows PowerShell 5.1's
   `Get-Content -Raw` assumes ANSI for a file with no BOM, so a
   `-replace | Set-Content` round trip silently mangles every em dash, middot
   and Chinese character in this document, and `Set-Content -Encoding utf8`
   adds a BOM that does not belong in `sw.js`. Both happened. Bump the version
   with an editor, not a shell rewrite.
9. **Bump the SW cache constant on every deploy.** `const CACHE = 'bp-log-vN'` in `sw.js`. Without a bump the old service worker keeps serving stale files and the update appears not to have worked.

---

## Guidelines

Thresholds are data, not code — `GUIDELINES` in `index.html`. Each band is `[label, minSys, minDia, cssColour]`, tested top-down; a reading matching **either** number falls in that band.

| Reading | Hypertension Canada 2025 | ESH 2023 / NICE |
|---|---|---|
| 118/75 | Normal | Normal |
| 124/79 | Watch | Normal |
| 132/82 | HTN | High-normal |
| 137/86 | HTN | Stage 1 |
| 142/91 | Treat | Stage 1 |
| 152/96 | Treat | Stage 2 |

- **ca** — Normal <120/80 · Watch 120–129 sys · HTN ≥130/80 · Treat ≥140/90 · Crisis ≥180/120
- **intl** — Normal <130/80 · High-normal 130–134/80–84 · Stage 1 ≥135/85 · Stage 2 ≥150/95 · Crisis ≥180/120

ESH/NICE home thresholds are deliberately the home-measurement values (135/85 corresponds to an office reading of 140/90), not office values. Canada is default; the Hong Kong use case is `intl`.

### Two fields that exist to stop the app overclaiming

`basis` — which kind of measurement the numbers were written for. Both sets are
home values; saying so is the point, because office and home thresholds for the
same condition are different numbers and a table that doesn't say which it is
invites the wrong comparison. Shown in the reference title and the printed header.

`unofficial` — bands the guideline body does not publish. `Watch` (120–129
systolic) is ours: a warning zone below the diagnostic line, worth keeping
because a home log is for spotting drift, but marked `†` in the reference table
and disclaimed in the printed footnote so a clinician is never handed an
app-invented label dressed as a clinical category. `intl` has none.

### Where the Canada numbers come from, and a correction

The 2025 update **lowered the out-of-office diagnostic threshold from 135/85 to
130/80**, for HBPM and daytime ABPM alike; 130/80 had previously been the 24-hour
ABPM cutoff. So the `ca` band `HTN ≥130/80` is correct for home readings under
the current guideline.

Note the trap, because it cost a wrong conclusion once: `hypertension.ca`'s
diagnosis pages still state HBPM 135/85, which is the **pre-2025** figure. Reading
that page alone leads to "the app grades home readings too harshly", and it is
wrong in the direction that makes a user complacent. The 2025 primary-care update
is the source that describes the change.

Two things in `ca` are still unresolved and should not be changed on a hunch:

- **`Treat ≥140/90`** — the update says the treatment threshold "remains ≥140/90"
  without stating office or home. With diagnosis now at out-of-office 130/80,
  applying an office number to home readings may be inconsistent.
- **`Crisis ≥180/120`** — `hypertension.ca` gives ≥180/110 for immediate
  diagnosis; the 2025 summary does not mention a crisis threshold at all.

Treatment thresholds are also risk-stratified in the 2025 guideline (average risk
≥140/90, low risk ≥160/100, diabetes ≥130/80, high risk and 75+ ≥130 systolic).
The app cannot know the user's risk category, so it does not try; the reference
panel and the printed footnote say so instead.

**Adding a guideline:** add an entry to `GUIDELINES` — including `basis` and
`unofficial`, even if `unofficial` is empty — and an `<option>` to `#glSelect`. The reference table, CSV Category column, and report footer all derive from the table automatically. Nothing else needs editing — that's the point of the data-driven design.

---

## Features

| Feature | Notes |
|---|---|
| Add reading | Auto timestamp, no manual date entry. Optional comment. Enter key submits. Guarded against double-tap. |
| Delete | Single delegated listener on `#log`, not one per row. Recoverable: the deleted record is held and an Undo appears in the message line until any other message replaces it. Only the most recent deletion, which is what the single control promises. |
| Stats | Avg systolic, avg diastolic, latest. Non-finite values filtered out. |
| Chart | Inline SVG, last 30 readings, systolic red / diastolic green. Hidden below 2 readings. |
| Row windowing | 50 rows rendered by default with a "Show all N" toggle. Rebuilding the log dominated render cost. |
| CSV export | UTF-8 BOM for Excel, separate Date and Time columns, comments quoted. A comment opening with `= + - @` gets a leading apostrophe — spreadsheets evaluate those as formulas and quoting does not stop them. |
| Backup / Restore | JSON. Restore merges by id, skips invalid records and reports how many. |
| Print report | For the doctor. Leads with 7-day / 30-day / all-readings averages, since guidelines assess a series average rather than single readings. Includes name/DOB blanks, category breakdown, full table, and guideline attribution. A4, black on white. |
| Settings | Collapsed by default. Guideline selector only. |

---

## Testing

```bash
npm install
npm test
```

Needs Node 18+. Dependencies are declared in `package.json`; `acceptance.js`
resolves `index.html` relative to its own location, so it runs from anywhere.

Loads the real `index.html` into jsdom with an in-memory IndexedDB and drives it as a user would — it is not a reimplementation of the logic. 184 checks across 22 groups: empty state, add, persistence across restart, validation, both guidelines' bands, delete, corrupt-data resilience, CSV, backup/restore round-trip, restore hardening, DB failure, chart, XSS in comments, id integrity, sorting, print report, guideline switching, reserved keys, and windowing.

`boot()` polyfills `Blob.prototype.text()` and `.arrayBuffer()` on top of jsdom's
`FileReader`. jsdom's Blob implements only `slice`/`size`/`type`, so without this
the CSV and backup assertions inspect `"[object Blob]"` rather than the file and
report results that mean nothing. `readBlob()` throws rather than falling back,
so a future jsdom change breaks the run loudly instead of quietly.

**Run it after every change.** Several of these tests exist because the bug they catch actually shipped:

- AT-21.3 asserts the report's category breakdown sums to the reading count — a hard-coded label list was dropping readings from the printed summary while the detail table still showed them.
- AT-15.5 asserts the newest entry is deletable after restart — a float-id bug broke exactly this.
- AT-17.2 asserts decimals are rejected rather than truncated.
- AT-7.5/7.6 assert bad dates are rejected on load — before this, a restored backup carrying free text or an impossible date landed in the log and skewed the averages.
- AT-6b asserts a delete can be undone, including that the original id comes back rather than a reissued one.
- AT-19.21 asserts Canada's Normal row bounds both numbers — it read "under 120 systolic" while `classify()` was tagging 110/85 as HTN, so the reference table contradicted the app on the same screen. AT-19.22 pins the other half: if that contradiction is ever "fixed" by changing `classify()` instead of the table, it fails.

---

## Deploying

1. Edit `index.html` (and `sw.js` if needed).
2. **Bump `const CACHE` in `sw.js`.** Non-negotiable.
3. `npm test` — must be green.
4. Commit and push to `main`.
5. Wait ~1–2 min for Pages.
6. On the phone: fully close the PWA (not just background) and reopen. The new service worker takes over once the old one releases.

### Why step 6 used to need two opens

Worth recording, because the obvious diagnosis was wrong.

Under cache-first, the worker that is **already active** answers the navigation
before the incoming worker exists. So launch 1 rendered the old shell from the old
cache, and only afterwards did the new worker install, `skipWaiting()`, activate and
claim — too late for a page that had already rendered. Launch 2 got the new shell.
`skipWaiting()` cannot fix this; nothing can, as long as the shell is served
cache-first.

It was first blamed on `addAll()` reading `index.html` from the HTTP cache, and
`cache: 'reload'` was added to rule that out. It didn't help, because that was never
the cause. The line is kept anyway — it closes a real if secondary hole, where a new
worker populates its fresh cache with the previous deploy's files.

The shell is now network-first with a `NAV_TIMEOUT` fallback to cache, so one
close/open is enough.

**Testing a change to this logic takes two deploys.** The currently active worker
serves the navigation, so version N's fetch behaviour is only observable from
version N+1 onward. v11 introduced network-first; v10 was still active when it
shipped, so v11 itself still took two opens. From v12 on, one should do it.

`sw.test.js` now covers the routing itself: it loads `sw.js` under a stubbed
service-worker global and asserts the shell is network-first, that offline, a
non-OK status and a hanging connection all fall back to cache, and that assets
stay cache-first. It takes an optional path argument, so a change can be run
against the currently deployed copy for comparison:

```bash
git show main:sw.js > /tmp/old-sw.js && node sw.test.js /tmp/old-sw.js
```

What it cannot cover is the update lifecycle — which worker answers which launch.
That still needs the device.

---

## Known limits

- **Data is local to the device.** No cloud sync. Losing or resetting the phone loses the history unless a JSON backup exists. `navigator.storage.persist()` is requested, which Android Chrome generally grants, but clearing Chrome site data still wipes it.
- **Web Share for files does not work** in this device's PWA — `canShare({files})` is rejected. An Email button was built and removed; the backup downloads instead and must be attached manually. Don't rebuild it without testing on the actual device first.
- **No encryption.** Anyone who opens the PWA on an unlocked phone sees the readings.
- **Single-user.** No profiles.

---

## Possible next steps

Nothing is committed to; these came up but weren't built.

- Optional cloud sync (Apps Script endpoint already prototyped) — reintroduces the network dependency this design avoided.
- Morning/evening tagging, which several guidelines treat separately.
- Medication or symptom fields alongside the comment.
- Date-range filter for the printed report.
- Additional guidelines: JSH 2025 and ACC/AHA 2025 both publish home-BP thresholds and would slot into `GUIDELINES` directly.
