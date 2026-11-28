# Internal App Demo — Warehouse Stock · Group Buy Pickup

**English** · [中文](README.zh-HK.md)

Two mobile-first internal tools I built for a small food business: a **warehouse stock** app and a
**weekly group-buy pickup counter**. In production a Google Sheet is the database (staff keep editing the
Sheet as usual; the apps read and write it live). This repository is the portfolio copy: the business
name and real data have been removed, and the apps can run in a **demo mode** with sample data, so no
Google account or server is needed.

**Live demo:** <https://stephenyctsedev.github.io/Portfolio/demos/internal-app/>

**Run it yourself:** open [`docs/index.html`](docs/index.html) in a browser, or publish the `docs/` folder
(GitHub Pages → *Deploy from branch* → `main` / `docs`, or import the repo into Vercel — `vercel.json`
is set up for the demo).

| App | Source | What it does |
| --- | --- | --- |
| **Warehouse Stock** | [`artifacts/warehouse/`](artifacts/warehouse/) | Stock list grouped by storage location, stock in / out, stocktake, multi-select bulk edits, camera barcode scanning, low-stock alerts, shelf-refill flags, per-item movement history |
| **Group Buy Pickup** | [`artifacts/groupbuy/`](artifacts/groupbuy/) | One Sheet tab per week (newest first), search by order number or name / product, swipe-to-confirm pickup with a timestamp, internal staff note per order, filter by customer or product |

Both apps have a Chinese / English language switch.

## Highlights

- **Google Sheet as the database, with no sync layer.** Every write re-reads the Sheet, finds the row by its
  key (item code / order number — never a remembered row number), and sends only the changed cells in a
  single atomic `batchUpdate`, so staff editing the Sheet by hand at the same time can't be overwritten.
- **Three builds from one codebase** (esbuild `define` flags):
  - *Claude Artifact* — a single self-contained HTML file that talks to Google Sheets through the viewer's
    own claude.ai connector, so the repo holds no credentials.
  - *Vercel web app* (`__WEB__`) — serverless API with a Google service account, per-person keys approved in
    a private "key book" Sheet, per-app read / write levels enforced on the server, and **passkey
    (WebAuthn) device binding** verified without external libraries ([`api/`](api/)).
  - *Portfolio demo* (`__DEMO__`) — the same apps on an in-browser stand-in for the Sheets API
    ([`artifacts/shared/demo-store.ts`](artifacts/shared/demo-store.ts)) seeded with fictional data
    ([`demo-data.ts`](artifacts/shared/demo-data.ts)) and saved in `localStorage`.
- **Phone-first UI:** React 19 + TanStack Query + Tailwind CSS 4, dark mode, large tap targets,
  swipe-to-confirm to prevent accidental pickups, home-screen icons.
- **Tests:** Playwright end-to-end tests against a fake Google Sheets API and simulated Face ID
  ([`artifacts/test/`](artifacts/test/)).

## Demo mode

```bash
npm --prefix artifacts ci --legacy-peer-deps
npm run build:demo        # → docs/index.html, docs/warehouse.html, docs/groupbuy.html
```

Everything in the demo is fictional. Changes are kept only in your browser; **Reset data** at the top
of each app restores the sample data. The demo never contacts Google.

The original server deployment config is kept as [`vercel.server.json`](vercel.server.json)
(rename it to `vercel.json` to deploy the full web app with keys and passkeys).

## History

The full commit history is kept, from the first prototype through the Muse Space versions to the
Claude Artifact and Vercel builds. Names identifying the original business, its spreadsheet IDs and its
customers have been replaced throughout ("Demo Co.", `DEMO_WAREHOUSE_SHEET_ID`, …).

---

# Project documentation

The rest of this file is the working documentation written for the business owner, translated into
English. The staff work in Chinese, so Sheet names, tab names and values the code looks for are
Chinese; they are shown in `code` with a translation, because the code matches them exactly.

This repo holds the source of two **Claude Artifacts** (each one an HTML file that runs inside claude.ai,
with its data in a Google Sheet):

| Artifact | Folder | Use | Data source (Google Sheet) |
| --- | --- | --- | --- |
| **Warehouse Stock** (`倉庫存貨`) | [`artifacts/warehouse/`](artifacts/warehouse/) | Warehouse inventory: browse stock, stock in / out, stocktake, shelf-refill flags, movement log | `倉庫存貨 - Demo Co.` |
| **Group Buy Pickup** (`團購記錄`) | [`artifacts/groupbuy/`](artifacts/groupbuy/) | Weekly group-buy pickup counter: find an order, tick "picked up" | `團購記錄 - Demo Co.` |

Both run in **direct mode**: the Google Sheet *is* the database. There is no local copy and no sync.
Every read and write goes straight to the Sheet, and if the Sheet can't be reached the app shows an
error instead of guessing. The page uses the `mcp` capability to call the viewer's own claude.ai
**Google Sheets connector**, so the repo contains no credentials. Build and test steps are in
[`artifacts/README.md`](artifacts/README.md).

> The earlier Muse Space versions (`warehouse-space/`, `group-buy-space/`, along with `AGENTS.md` and
> `DATA-PLAN.md`) have been removed; they are still in the git history.

## Chinese / English language switch

Every page (warehouse, group buy, the application form, "My key", the admin page) has a `中 | Eng` button in the top
right. One tap switches the language; Chinese is the default. The choice is remembered on the device
(`localStorage`; the web app also sets a `lang` cookie so the form, the key page and the apps agree).
Only the interface is translated: product names, tab names and anything written to the Sheet (such as
movement types and notes) stay in Chinese, and the emails sent to the administrator are in Chinese.
The blank error page has no text, so it has no switch.

To change interface text: the front end uses `t("中文", "English")`
([`artifacts/shared/i18n.tsx`](artifacts/shared/i18n.tsx)), server pages use `L("中文", "English")`
([`api/_ui.js`](api/_ui.js)), and the English API error messages are in [`api/_i18n.js`](api/_i18n.js).

## Vercel web app (one server, two apps)

The same source can be deployed to Vercel as a web app that works without claude.ai. Features and UI are
the same as the two Artifacts; the only difference is that the Google Sheets are read and written by the
server (with a Google service account) instead of through each user's claude.ai connector.

### Keys: one per person, each app approved separately (read / write), every device approved by you

Each person has **their own key**, which works only after you approve it in a private Google Sheet
(the **key book**). Warehouse and group buy are approved separately, and for each app you choose
**read** (`閱讀`, view only) or **write** (`寫入`, view and change).
**You decide which apps someone is invited to**: on your own **admin page** you pick the apps and make an
invite link on the spot; staff can't pick for themselves. The Sheet stores only the key's SHA-256 fingerprint, **never the key itself**; the key is
shown once, on the applicant's phone.

**A key alone is not enough**: every device must register a **passkey** (Face ID / fingerprint / screen
lock), and the app opens only after you tick that device in the "Devices" tab. If someone passes their
link on, the other person's device doesn't have the passkey and can't open the app; at most they can
"register a new device", and you get an email when they do.

| URL | What it is |
| --- | --- |
| `https://<your-domain>/?admin=<admin-code>` | **Admin page (for you only)**, two tabs: **Approve** (new applications / new devices: choose read / write, approve / block / delete devices, delete a person); **Invite links** (pick apps → make a link (copy / WhatsApp); see the links you made, stop one, clear the ones that no longer work; remove old invite codes) |
| `https://<your-domain>/?invite=<invite-code>` | Application form: enter a name only (the apps applied for come from the link) → receive a personal key |
| `https://<your-domain>/?key=<their-key>` | "My key" page: register / unlock this device, see which apps are approved, tap "Open" |
| `https://<your-domain>/?app=stock&key=<their-key>` | Warehouse Stock (needs read or write on "Warehouse" **and** this device ticked) |
| `https://<your-domain>/?app=groupbuy&key=<their-key>` | Group Buy Pickup (needs read or write on "Group buy" **and** this device ticked) |

**Flow**

1. Open your admin page (`/?admin=<admin-code>`; bookmark it) on the "Invite links" tab, tick which apps they can apply for
   (warehouse / group buy / both), choose how many times the link can be used (once / 5 / 20 / no limit,
   default once) and how long it lasts (1 day / 7 days / 30 days / no limit, default 7 days), optionally
   note who it's for → tap "Make link" → "Copy" or "WhatsApp" it to them. Every tap makes a new link,
   recorded in the key book's "Invites" (`邀請`) tab. The admin page can also be added to the home screen
   (indigo key with an amber "+" icon) so it opens in one tap.
2. They enter their name (the form shows which apps they are applying for; they can't change it) → a row
   is added to the "Keys" tab and you get a "new application" email → they land on their own "My key"
   page → they tap "Register this device" and confirm with Face ID / fingerprint → a row is added to the
   "Devices" tab and you get a "new device" email.
3. Open the admin page's "Approve" tab (the number on the tab = how many are waiting); they are listed
   under "Waiting for approval": set "Warehouse" / "Group buy" to read or write, then tap "Approve" on
   their device (takes effect within 30 seconds). You can skip the admin page and do the same in the
   Sheet: set their cell in the "Keys" tab, then tick "Approved" in the "Devices" tab. Their page checks
   every 20 seconds and updates by itself once approved.
4. They tap "Open" → in Safari, *Share → Add to Home Screen* (Android: Chrome menu → *Add to Home
   screen*). The first time the home-screen app opens it asks for one Face ID / fingerprint unlock (the
   same passkey, **no second approval needed**).
5. To give them another app later, or raise read to write: open them under "Everyone" on the admin
   page's "Approve" tab, or change the "Keys" tab directly.

**New devices**: when someone changes phone, uses a computer, or someone opens a forwarded link on
another device, that device only sees "Confirm this device". Without a passkey it has to "Register this
device" → an unticked row appears in "Devices" and you get a "new device" email. If it's really them,
approve it (tap "Approve" on the admin page, or tick it in "Devices"); if not (the link was passed on),
don't approve it: tap "Delete" on the admin page or delete the row. Devices on the same Apple
ID / Google account sync passkeys automatically: they just tap "Unlock", no new row, no approval.

**Each device needs a Face ID tap every 30 days** (the session cookie lasts 30 days). On iPhone the
home-screen app and Safari are counted separately.

| Device | How it registers / unlocks |
| --- | --- |
| iPhone / iPad | Face ID / Touch ID / passcode (iCloud Keychain) |
| Android | Fingerprint / face / screen-lock PIN (Google Password Manager); a screen lock must be set |
| Mac | Touch ID / login password |
| Windows | Windows Hello (PIN / fingerprint / face); at least a Windows PIN must be set |
| Computer without biometrics | The browser shows a QR code to scan with a registered phone (Bluetooth must be on) |

Shared work computers: a passkey belongs to the machine (and Windows account), not the person. Treat the
computer as one person, for example "Warehouse PC".

**Managing the key book** (for the approval rows, the admin page's "Approve" tab and editing the Sheet do
the same thing; use either)

| You want to | Admin page "Approve" tab | In the Sheet |
| --- | --- | --- |
| Let someone view an app | Set their app to "View" | "Keys" tab: set their "Warehouse" / "Group buy" cell to read (allowed even for an app they didn't apply for) |
| Let someone change an app | Set it to "Edit" | Same, choose write |
| Take away access to an app | Set it to "None" | "Keys" tab: clear that cell |
| Approve a device | Tap the device's "Approve" | "Devices" tab: tick "Approved" |
| Block a device (lost phone, unknown device) | "Disable", or "Delete" (deleted = must register again) | "Devices" tab: untick it, or delete the row |
| Revoke a whole key (someone leaves) | "Delete this person" (their device rows go too) | "Keys" tab: delete their row → the link becomes a blank page at once and all their devices stop working |
| Make a new invite link | Admin page "Invite links" tab: pick apps → "Make link" | |
| Stop an invite link | Admin page: tap "Stop", or delete that row in the "Invites" tab |
| Clear expired / used-up links | Admin page: tap "Clear expired / used-up links" (deletes only the rows that no longer work) |
| Remove the old fixed invite codes | Admin page: tap "Remove" under "Old invite codes" (deletes that "Settings" row), or clear it yourself |
| Change a link's apps / expiry / uses | | "Invites" tab: edit B / C (☐), F (expiry) or G (uses allowed); takes effect within 30 seconds |
| Invalidate the admin page address (e.g. it was shared by mistake) | | "Settings" tab: change "admin code" (`管理碼`) to a new string (anything, at least 12 characters) |
| Close the admin page | | "Settings" tab: clear "admin code" |

- **"Keys" tab**: A name · B warehouse ▾ · C group buy ▾ · D applied for · E applied at (Winnipeg time) ·
  F key fingerprint. B and C are drop-downs: blank = no access, `閱讀` = read only, `寫入` = read and write.
  In an older key book these two columns were checkboxes: a ticked box counts as write (so nobody suddenly
  loses access), and the server converts them to drop-downs the first time it reads the Sheet (ticked →
  write, unticked → blank); there's nothing to change by hand.
  **Don't edit column F**, or the key stops working. Sorting and adding note columns after column G is fine.
- **"Devices" tab**: A name · B approved ☐ · C device (e.g. "iPhone · Safari", for your information) ·
  D registered at · E key fingerprint · F passkey ID · G algorithm · H public key. **Don't edit columns E–H.**
- **"Invites" tab**: A invite code · B warehouse ☐ · C group buy ☐ · D who it's for · E created at ·
  F expires (Winnipeg time; blank = never) · G uses allowed (blank = no limit) · H used. The admin page
  writes it, so you normally don't touch it; a link with neither B nor C ticked, past its expiry, or used
  up becomes a blank page. If two people open a single-use link in the same second, both may get to
  apply — you still have to approve both.
- **"Settings" tab**: column A is the name, column B the value. Rows are found by the name in column A,
  so they can be reordered, but **don't rename anything in column A**. "admin code" (`管理碼`) is the
  string in the admin page address. Older key books also have "Warehouse invite code" / "Group buy invite
  code" / "Warehouse + group buy invite code" rows: those old links **still work**, and the admin page
  lists them under "Old invite codes", where "Remove" deletes the row (they stop working at once).
- All four tabs are created automatically on first use (your own tabs are left alone), and the admin code
  is generated automatically. An older key book (no "Invites" tab, no admin code) gets them added the
  first time the server reads it.
- Flood protection: new applications / devices are paused when more than 20 people are waiting with
  neither app approved, more than 30 devices in "Devices" are unapproved, or one person has more than 3
  unapproved devices. Deleting the rows you don't want lifts the pause.

**Passkeys are tied to the domain**: a passkey works only on the address where it was registered. Use one
fixed, official domain (don't mix `xxx.vercel.app` with your own domain, and Vercel preview URLs won't work).
Changing domain = everyone registers their devices again.

**Still a blank page with no text at all** when: `app` / `key` / `invite` / `admin` is empty or wrong, the
key's row was deleted, the invite link was stopped / has expired / is used up, the admin code is wrong or
was cleared, or `invite` or `admin` appears together with other parameters.
The error screen doesn't even have a tab title, just a "dead web page" image, and never says what was wrong.
The page itself is not a public static file: `/` is rewritten to `api/app.js`, which returns the HTML only
after checking the key **and the device**. Every Sheet read and write is a POST to `api/sheets.js`, which
checks again that the key is approved for that app and the device (session cookie) is ticked. Each `app`
can only touch its own Sheet, and only three kinds of write are allowed:
`updateCells` / `appendCells` / `deleteDimension` (the same as the Artifact version).

**"Read" is enforced on the server, not just by hiding buttons**: for someone with read access,
`api/sheets.js` answers only the two read tools (`get_values` / `get_spreadsheet`); any
`update_spreadsheet` gets a 403 and nothing is written. The app page receives a
`<meta name="app-access">` ([`artifacts/shared/access.ts`](artifacts/shared/access.ts)), shows
"Read only" at the top, and hides every button that writes. Warehouse loses add item, multi-select,
＋ / −, edit quantity, stock in / out, shelf refill / refilled, edit item and edit movement; group buy
loses the "picked up" swipe and the "✎" staff note button (existing staff notes are still shown). Search, filters and the movement log still work. Their "My key" page shows
"Read only" or "Can change" for each app. The claude.ai Artifact version isn't affected: there everyone
uses their own Google account, so sharing the Sheet as viewer or editor is what decides read or write.

**Technical details**: passkeys use the browser's built-in WebAuthn (ES256 / RS256), and the server
verifies signatures itself (`api/_passkey.js`, no external library). After login it issues a 30-day
HttpOnly session cookie (one per key), signed with an HMAC derived from the service account's private key;
replacing the service account key means everyone taps Face ID once more.

**App icons**: warehouse is an orange square with shelves and boxes, group buy is a green square with a
ticked shopping bag (matching each app's main colour), and the admin page is indigo with a white key and
an amber "+" ("hand someone a key"; not an app colour, so it can't be mixed up with the two apps). They are used when the app is added to the home
screen, and the shortcut remembers the full link (including `?app=` and the person's own `?key=`).
The source is [`artifacts/icons/make-icons.mjs`](artifacts/icons/make-icons.mjs); after changing it, run
`node artifacts/icons/make-icons.mjs` to regenerate `public/icons/` (it needs Playwright, which is why the
PNGs are committed). The error screen never uses an icon.

**Vercel setup**

1. Import this repo with the repo root as Root Directory (`vercel.json` already sets install / build).
2. Create a new Google Sheet as the **key book** (for example "Key book - Demo Co."), and share it
   **only** with the service account (as editor), never with staff.
3. Environment variables:
   - `GOOGLE_SERVICE_ACCOUNT_JSON` — the whole JSON key of a Google Cloud service account
     (with the Google Sheets API enabled). Or use `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY` separately.
   - `ACCESS_SHEET_ID` — the key book's Sheet ID (the part of the URL between `/d/` and `/edit`).
     Not set = no key works.
   - `NOTIFY_EMAIL` — where to email new applications (new keys) and new device registrations.
   - `RESEND_API_KEY` — sends email through [Resend](https://resend.com) (the free plan is enough).
     Sign up to Resend with **the same address as `NOTIFY_EMAIL`** to use the default sender
     `onboarding@resend.dev`; if you verify your own domain in Resend, you can add `NOTIFY_FROM`
     (for example `Key book <keys@your-domain>`). Without these two, no email is sent but applications
     still go into the key book, and a failed email never blocks an application.
   - The old `STOCK_KEY` / `GROUPBUY_KEY` are no longer used and can be deleted if set.
4. Share both the warehouse and group-buy Google Sheets with the service account's email as **editor**.
5. After deploying, open `https://<your-domain>/?invite=x` once (you'll see the blank page; that's
   expected) — the key book then gets its "Keys", "Devices", "Invites" and "Settings" tabs. Copy the
   admin code from "Settings", open `https://<your-domain>/?admin=<admin-code>`, bookmark it, and make
   invite links there.

**Running locally**

```bash
npm --prefix artifacts ci --legacy-peer-deps
npm run build                                  # → api/_pages.js (not committed)
ACCESS_SHEET_ID=… GOOGLE_SERVICE_ACCOUNT_JSON="$(cat sa.json)" npm run dev   # http://localhost:3000/?admin=…
node artifacts/test/web_e2e.mjs                # fake Google + fake email, Chromium simulating Face ID: key + device gate, both apps, admin page invite links (uses / expiry / stop / old codes), admin page "Approve" tab (read / write, approve / block / delete devices, delete a person), new devices, synced passkeys, approve / block
```

## Warehouse Stock (`artifacts/warehouse/`)

**Sheet layout** (the column order is fixed and won't change again):

- Main tab `Sheet1`, 13 columns: A item code (**key**) · B source invoice · C English name · D Chinese name ·
  E pack / size · F barcode · G quantity · H unit · I storage · J low-stock threshold · K notes ·
  L last updated · M shelf status
- `出入記錄` (movement log) tab: ID / date / item ID (stores the item code) / item / change / type / note,
  append only
- `Space 更新狀態` (Space update status) tab: the last version, with a hand-written handover document; see
  the rules below

**Features**

- Item list: two search boxes (left: numeric item code only; right: name / barcode / notes), each item opens
  its own movement history, **barcode scanning** (the Artifact can't open a live camera, so it decodes a
  photo taken or picked), two rows of filters for location × status (combined with AND)
- Locations: frozen 1F / frozen 2F / frozen (undecided) / unclassified (dry goods and fresh are hidden in
  the form and filters, but the data layer still supports them); every view is grouped by storage and
  groups can be collapsed
- Add / edit / delete items; stock in / stock out / set quantity directly (every quantity change appends a
  row to the movement log)
- **Shelf refill** flag and **refilled**: pure status changes that **don't change the quantity**
- **Multi-select** bulk actions: storage location, shelf status, stock in / out, unit, low-stock threshold, delete
- Movement log entries can be edited (quantity, type, note); changing the quantity adjusts the item's
  stock by the difference
- Tapping an item name in the movement log tab opens that item's history (the same popup as the stock tab)
- Low-stock alert: `quantity <= low_stock` (0 counts too); an item at 0 shows as out of stock

**Rules that must not change**

- Always find the row by **column A, item code**, never by row number or ID; re-read the Sheet before every write.
- An item code is 7 characters, or a temporary code like `TMP-001`; left blank, the next TMP code is
  assigned automatically; any other length isn't saved. Barcodes may repeat.
- A quantity can never go negative (including bulk edits and movement log edits).
- Shelf refill / refilled only change the status in column M; they don't touch the quantity or write to the
  movement log. Quantity changes are a separate stock in / out.
- Bulk writes must be **one `batchUpdate`** (never row by row).
- New items default to storage `unclassified`; 1F / 2F are always decided by a person (automatic
  classification was removed).
- `Space 更新狀態` tab: update **only** the two rows "last updated time" and "total items" (writing column B
  in place). Never overwrite the whole tab or delete rows — the hand-written handover above must stay intact.

## Group Buy Pickup (`artifacts/groupbuy/`)

**Sheet layout**: one tab per week, named after that week's Monday (for example `2026-11-23`); row 1 is a
frozen header:

| A order no. | B name | C customer note | D product | E qty | F unit | G note | H picked up | I picked up at | J staff note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

An order is several consecutive rows with the same order number; **H "picked up", I "picked up at" and
J "staff note" are only on the first row of each group**. The J header may be left blank: the first time
a staff note is saved from the app it writes `員工備註` ("staff note"). If the J header holds something else
(someone is using column J for another purpose), the app still works but neither shows nor writes staff
notes.

**Features**

- Week picker (new tabs appear automatically; defaults to the newest week, the right-most tab in the
  Sheet) and a picked-up progress bar
- Order cards: name, customer note, products and quantities. "Mark as picked up" needs a **swipe right**
  on the slider, "Mark as not picked up" a **swipe left** (the slider starts from the right); they write
  H (and I). Only a swipe past 93% counts; a tap or half swipe writes nothing
- Two search boxes: a narrow one for order numbers only (numeric keypad), a wide one for name / product
- Filters: all / not picked up / picked up, multiple products (OR), tap a customer name to see only their
  orders; all combine, and switching week clears them
- With products selected, a total of how many are still waiting for pickup is shown (by unit)
- **Staff note**: on each order, "✎ Add staff note" / "✎ Edit" records an internal note (e.g. "customer
  will be late", "phoned them"); several lines, up to 500 characters; clear it and save to delete it.
  Kept apart from C customer note and G note (which come with the order); only column J is written
- "↻ Load" re-reads the Sheet and shows "Loading…" while it does

**Rules that must not change**

- Re-read the tab before writing, find the group's first row by **order number**, and write only H / I on
  that row — never a remembered row number.
- Staff notes work the same way: re-read the tab, find the first row by order number, write only J. If
  the note in the Sheet differs from the one you started editing (a colleague just changed it), nothing is
  written and a notice shows what they wrote; your text stays in the box, and only tapping "Save" again
  overwrites it.
- Ticking "picked up" writes I = Winnipeg time `YYYY-MM-DD HH:mm`; setting it back to not picked up clears I.
- Winnipeg time is a **fixed UTC−5** (Manitoba stays on daylight time permanently from 2026-11-01).
- Order data lives only in the Sheet; nothing is written locally.

## Before changing anything

1. Changing the Sheet's column order (especially warehouse A:M) would make reads and writes hit the wrong
   columns. Both apps check the header (warehouse A1 must be `貨品編號`, "item code"); if the layout is
   wrong they refuse to write rather than write to the wrong place.
2. Never commit private data, tokens or keys from the Sheets to the repo.
