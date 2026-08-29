# customer CRM

I am dan.

I run a real estate business.

I want to create a table of tenants.

## Running

```
bun run dev     # or: bun run start
```

Serves on http://127.0.0.1:3000. Everything requires signing in; the only pages
reachable signed out are the login and sign-up forms.

| Route          | What it is                                               |
| -------------- | -------------------------------------------------------- |
| `/login`       | Sign-in form                                              |
| `/register`    | Sign-up, for approved usernames only                      |
| `/`            | Tenants, Access &amp; Homes — the door-code table, then the Home/Unit doc |
| `/doc`         | Redirects to `/#homes` (the two pages were merged)        |
| `/workflow`    | Prospect Management Workflow, same treatment               |
| `/sheets/:id`  | One editable sheet — `tours`, `leases`, `vendors`          |
| `/sheets`      | Redirects to the first sheet (old bookmarks still work)    |
| `/inspections` | Every signed move-in condition report, newest first        |
| `/inspections/:id` | One report, room by room, with its photos and signatures |
| `/inspections/:id.pdf` | The signed PDF, plus any comments as an addendum   |
| `/inspections/:id.pdf?original=1` | The PDF exactly as it was signed        |
| `/inspections/uploads/:file` | A photo or video attached to a report         |
| `/api/inspections/:id/notes` | `POST {body}` a comment — anyone signed in    |
| `/api/inspections/:id/notes/:noteId` | `DELETE` one — its author, or `dan`   |
| `/api/tenants` | `GET` JSON; `POST` a new tenant — **`dan` only**           |
| `/api/tenants/:id` | `PUT` one row — **`dan` only**, see "Who can edit"     |
| `/api/tenant-columns` | `PUT {columns:[{field,width}]}` — **`dan` only**   |
| `/api/sheets`  | `GET` all sheets with revs; `PUT {sheets:[...]}` — one sheet, rev-checked |
| `/favicon.svg` | The tab icon (also served at `/favicon.ico`)              |

### The tab icon

`public/favicon.svg` — a heavy red slanted **R**, drawn as an SVG path rather
than set in a font so it looks the same on every machine, and transparent behind
so it reads on a light or a dark tab strip. It's a letterform of our own in that
style, not the Team Rocket artwork itself.

It's served above every other route in `server.ts`, because the signed-out pages
want it too, and it's the only response in the app that isn't somebody's
personal information — so it's also the only one allowed to be cached
(`max-age=86400`; hard-reload after changing it). `/favicon.ico` returns the same
file, for browsers that ask unprompted. Every page points at it explicitly:
`FAVICON_LINK` in `auth.ts` covers the sign-in pages and Tenants & Access, and
`doc.ts` and `public/sheets.html` carry the same line where they build their own
`<head>`.

Environment: `PORT` (default 3000), `HOST` (default `127.0.0.1`), `DB_PATH`
(default `crm.db` — point it at a copy when testing), `TRUSTED_ORIGINS` (below),
`BASE_URL` (used in invite links). Bun loads these from `.env` automatically.

### Behind a reverse proxy

Writes are rejected as cross-origin unless the browser's `Origin` matches the
host the server sees. A proxy that doesn't forward the original `Host` breaks
that: the page loads (reads aren't checked) but every save fails with 403 and
the editor sits on "Save blocked". List the public address to fix it:

```sh
TRUSTED_ORIGINS=https://crm.example.com        # comma-separated for several
```

It's an explicit list rather than trusting `X-Forwarded-Host`, since any client
can send that header and it would reopen the CSRF hole the check exists to
close. The scheme is part of the match, so `http://` and `https://` are distinct.
The startup line prints what's trusted, and a rejection logs both the `Origin`
and the `Host` it was compared against.

## Accounts and sign-in

Everything here is tenant PII — names, phones, home addresses, rent, and the unit
door codes in the Leases sheet — so every route requires a signed-in user.

**First run:** with no accounts in the database, opening the app on this machine
sends you to `/setup` to create the first one, and signs you straight in. That
page is only served to requests from localhost, and stops existing the moment an
account exists — so it can't be used to add a second account later.

**Approving teammates.** Sign-up is open to approved usernames only. Add someone
to the list and they can create their own account at `/register`, choosing their
own password — you never handle it:

```sh
bun run users approve ada --name "Ada"
bun run users approved             # who may sign up, and who already has
bun run users unapprove harsh      # take them off the list
```

The login and sign-up pages link to each other, so people can find either one.

**Stricter option.** `invite` instead of `approve` also requires a one-time code,
handed out as a link:

```sh
bun run users invite lee --name "Lee"
# -> http://localhost:3000/register?u=andy&code=<one-time code>
```

Use it when the app is reachable by people outside the team. Plain `approve`
means whoever signs up first as that username gets the account — the list proves
the *username* is approved, not who is typing it. A code proves both. The code is
shown only once; re-run `invite` to issue a fresh one. `bun run users approved`
shows which mode each person is on.

The link's host comes from `BASE_URL` (default `http://localhost:3000`), so set it
once the app has a real address:

```sh
BASE_URL=http://dan-laptop:3000 bun run users invite hieu
```

**Note on revoking.** The approved list gates *account creation*, not sign-in — so
removing someone from it does not lock out an account they already made. Use
`bun run users remove <username>` for that; it deletes the account and their
sessions at once.

You can also create accounts directly, choosing the password yourself:

```sh
bun run users add ada --name "Ada"      # prompts for a password, twice
bun run users list                      # who exists, last login, active sessions
bun run users passwd dan                # change a password
bun run users remove maria              # delete the account
bun run users logout maria              # end their sessions, keep the account
```

Removing someone, or changing their password, signs them out on their very next
request — sessions live in the database, not in a token that has to expire.

### How it works

- Passwords are stored as argon2id hashes (`Bun.password`), never in plain text.
  Minimum 8 characters.
- Signing in sets a random 256-bit session cookie: `HttpOnly` (JavaScript can't
  read it), `SameSite=Lax` (another site can't ride along on a logged-in
  browser), and `Secure` whenever the request arrives over HTTPS.
- The database stores only a SHA-256 *hash* of that cookie, so a leaked copy of
  the `sessions` table can't be replayed as a login.
- Sessions last 14 days and renew as you use the app.
- Eight failed attempts against one account trigger a 15-minute lockout, so
  passwords can't be guessed at speed. A looser per-IP cap (40) catches someone
  spraying guesses across many usernames without letting one person's fumbled
  password lock out a whole team sharing an office connection.
- Wrong password and unknown username return the identical page, and take the
  same time, so the form can't be used to discover who has an account. Sign-up
  gives one answer for "never approved" and "already claimed" alike.
- State-changing requests carrying a foreign `Origin` are rejected (CSRF).
- Failed and successful logins, every sheet save, and every tenant added, tenant
  edited or column-layout change — including the ones refused because the account
  isn't the owner's — are logged to the server console with the username.

### Reaching it from other machines — read this first

By default the server binds `127.0.0.1`, so only your laptop can reach it. To let
teammates in you'd set `HOST=0.0.0.0` — **but not over plain HTTP.** Passwords and
session cookies would cross the network in cleartext, readable by anyone on the
same Wi-Fi. Passwords authenticate; they don't encrypt.

Two ways to get encryption, either of which works with the login system as-is:

- **Tailscale** (simplest): install it on your laptop and your teammates'
  machines, keep `HOST=127.0.0.1`, and they reach the app at your machine's
  tailnet address. Traffic is encrypted between devices and nothing is exposed to
  the public internet. The login page then acts as a second layer.
- **A TLS reverse proxy** such as Caddy, which gets a certificate automatically.
  Point it at `127.0.0.1:3000` and keep the app bound to loopback. This needs a
  domain name and an open port.

Also note the app is only up while `bun run dev` is running and your laptop is
awake.

### Backing up

The database now runs in WAL mode, so **copying `crm.db` on its own is not a
complete backup** — recent writes may still be sitting in `crm.db-wal`. Take a
consistent single-file snapshot instead:

```sh
bun -e 'import{Database} from "bun:sqlite"; new Database("crm.db").run(`VACUUM INTO '\''backup.db'\''`)'
```

That warning is not theoretical: on 2026-08-05 three `cp crm.db` backups taken
during a debugging session all captured the same six-day-old state, because
everything since had been written to the WAL and not yet checkpointed. The
`.backup`/`VACUUM INTO` form gets it right.

A `PUT` to `/api/sheets` no longer replaces every sheet — it writes only the
sheets it names, and only if they haven't moved on since the page loaded. See
"Two people editing at once" below.

## Tenants

### Who can edit

Everyone signed in can *read* the Tenants & Access page. Only the account
`dan` can change it. Signed in as anyone else the page looks exactly as it
always has — no Edit buttons, and none of the editor's JavaScript is even sent.

The rule is one constant, `TENANT_EDITOR` in `auth.ts`, matched against the
username case-insensitively (usernames are `COLLATE NOCASE`, so `Ada` and `ada`
are the same account). To hand editing to someone else, change that constant —
there's no role column in the database.

What matters is that the check runs on the *server*, in the `PUT
/api/tenants/:id` route: hiding the button is a convenience, and someone who
knows the URL still gets a 403, logged with their username. It applies to the
account, not the person, so it's only as good as the owner's password.

**Editing.** Click Edit on a row: it becomes inputs, Save writes it, Cancel (or
Escape) puts it back. Enter saves. One row is open at a time. A save replaces
every editable column of that row at once, so clearing a field blanks it —
`notes`, which carries the import provenance, isn't editable and survives. Rows
are ordered by property/unit/surname; edit one of those and it stays put until
the next page load. Rejected saves (bad date, no name, rent that isn't a number)
show the reason under the buttons and leave the row open.

**Adding.** "+ Add tenant" above the table opens a blank draft row at the top,
with status defaulting to `active`. Nothing is written until you press Save, so
Cancel or Escape just discards it — a draft that's never saved leaves no trace in
the database. It goes through the same validation as an edit, so the one real
requirement is a first or last name; everything else can be filled in later. A
refused add keeps the draft open with what you typed. Once saved the row is
ordinary — editable straight away, and sorted into place on the next load.

Rows can be added and edited from the page, but not **deleted** — that's still
`sqlite3` or the `bun -e` route.

**Rented rows are folded away.** A unit with `status = 'rented'` is off the main
list and in a collapsed "Rented" section at the foot of the same table, with a
count beside it; clicking the bar expands it. Collapsed is the default on every
load — the section is `hidden` in the markup, so it stays shut for anyone with
JavaScript off rather than falling open. Everyone gets the toggle, editors or
not. The rented rows are still ordinary rows of the same table, so the shared
column widths and order apply to them unchanged.

Editing a row's status to or from `rented` moves it to the other section on
save, and the count follows; the section opens itself so the row doesn't appear
to vanish. If the last rented row leaves, the bar goes away. The moved row lands
at the end of its new section until the next load sorts it back into
property/unit/surname order.

**Columns.** The owner can also set the width and order of the table's columns, the
same way as on the sheet pages: drag a heading sideways to move it (a blue bar shows
where it lands), drag its right edge to resize, double-click that edge to type an
exact width in pixels (48–2000), or right-click a heading for the same three plus
"Reset all columns". The actions column stays pinned last.

**This layout is shared, not per-person** — it's one row in the `settings` table,
so what the owner arranges is what everyone else sees on their next load. They can't
drag anything themselves; they get no handles and no script. Saves happen as soon
as you let go of a drag; if one fails, a red line under the table says so, and
your view is correct until you reload.

Column order is stored against stable keys (`property`, `unit`, `access`, …), not
against headings, so a heading can be reworded without stranding the saved
layout. A stored layout is filtered back through the column list in `server.ts`
on every page load: a column deleted from the code drops out of a stale layout,
one added since lands at the end where you can see it, and an unparseable setting
logs a warning and falls back to the defaults rather than serving a broken table.

Widths only apply to the wide layout. Under 640px the table still becomes cards,
where they'd mean nothing.

### Where the rows came from

12 rows were copied out of the Home/Unit Information doc on 2026-07-27: the seven
occupied studios at 12 Example Ave NE plus vacant unit 101 (each with its unit
door code and the shared building code), and the whole-property tenants at 90 Birch
Pl, 56 Poplar Ave NE #L, and units 3 and 4 of 34 Sample Ave NE. They carry
`Imported from Home/Unit Information doc, 2026-07-27` in `notes`.

Units 101 and 104 are recorded with `status = 'vacant'`, which meant widening the
`status` CHECK constraint — it previously allowed only active/past/pending. On a
vacant unit `lease_end` is when the vacancy ends, and the page renders it as
"vacant until …" rather than "ends …".

Unit 104 (access code redacted, vacant until 2026-07-31) came from the owner on
2026-07-27; it isn't in the doc's availability table.

On 2026-08-04, units 104, 201, 404 and 406 were marked `status = 'rented'` at
the owner's request, which widened the CHECK constraint again (SQLite can't alter one,
so the table was rebuilt into a new one and renamed; `crm-backup-2026-08-04-pre-rented.db`
is the copy taken first). On 2026-08-05 the placeholder name "Vacant" and the
stale 2026-07-31 date were cleared from 104 at the owner's request, since the unit is
no longer vacant (`crm-backup-2026-08-05-pre-104.db` is the copy taken first).

Later on 2026-08-05, at the owner's request, every 12 Example Ave NE row **except unit
101** was deleted — units 004, 104, 201, 401, 402, 403, 404 and 406, including
the tenant names, emails, phones and door codes on them. Only vacant unit 101
(access code and building code redacted) remains for that property.
`crm-backup-2026-08-05-pre-4544-purge.db` is the copy taken first, so those eight
rows can be restored from it if the deletion was broader than intended.

The four whole-property tenants have a move-out date of 2026-08-31. That came
from the owner directly; the doc doesn't give lease dates for them.

Two columns were added for the door codes: `access_code` (the unit's own) and
`building_code` (shared by the building), shown in the page's Access column.

This was a one-time copy, **not a live sync** — editing the doc won't update
these rows, and editing these rows won't update the doc.

What the doc didn't provide, and so is blank here: lease start dates, rent
amounts, and email addresses/surnames for the four whole-property tenants. The
doc quotes rent per unit *type* rather than per tenant, so filling `rent_amount`
in would have meant guessing.

The three seeded placeholder rows (Alice Nguyen, Ben Carter, Carla Diaz) were
deleted on 2026-07-27. The page still tags any row with an `@example.com` address
or a `555-01xx` number as `sample`, so a stray placeholder can't quietly pass for
a real tenant.

The Leases sheet under `/sheets/leases` holds a separate, overlapping set of tenant
records; the two are not synchronised either.

## Sheets

`/sheets/:id` is a spreadsheet editor over the `sheets` table (one DB row per
sheet, with columns and rows stored as JSON so the grid stays free-form).

**Each sheet is a top-level tab of its own**, alongside Tenants, Access &amp;
Homes — `/sheets/tours`, `/sheets/leases`, `/sheets/vendors`. They used to be
sub-tabs inside a single "Tours & Leases" page; that in-page tab strip is gone,
and bare `/sheets` redirects to the first sheet so old links still work.

The nav bar is built from the `sheets` table, not written out in the code, so
adding a sheet or renaming one puts it in the bar on the next page load — in
every page's bar, since `server.ts` renders it for all of them. `public/sheets.html`
is one file shared by all the sheet pages; `renderSheet()` stamps the nav, the
page title and which sheet to open into it. That bar now scrolls sideways rather
than wrapping, because five tabs don't fit a phone, and the sheet pages picked up
the "signed in as … / Sign out" control the other pages already had.

It supports cell editing,
keyboard navigation, multi-cell selection, copy/paste, undo/redo, sort, search, column
resize/rename/reorder, row and column insert/delete, and CSV export. Edits autosave to
SQLite about 0.7s after you stop typing.

Columns:

- **Resize** — right-click a header and pick "Column width…", or double-click the
  header's right edge, then type a width in pixels (48–2000). Dragging that edge
  still works too. A typed width is undoable; a drag is not.
- **Reorder** — drag a header sideways; a blue bar shows where it will land. Or
  right-click a header for "Move column left/right". Every row's cell travels
  with its column, and the move is undoable like any other edit.
- **Rename** — double-click a header, or right-click it.

### How tall a cell is

Every column shows **one line** and cuts the rest off, with two exceptions in
Tours & Prospects: **Location** gets two lines and **Personal Opinion** three.
Nothing is lost — the full text is still there when you open the cell, and a row
only grows as tall as its most generous column.

That comes from a `lines` number on the column itself (in the sheet's JSON,
beside `name`, `type` and `width`), so it survives a save and can be changed per
column without touching code. Leave it off and the column shows one line. The
Leases **Comment** column is on that default and is often longer than one line —
give it `lines` if you'd rather see more of it.

Cells still **wrap**: text fills its lines and long unbroken values (emails,
URLs) break mid-word rather than overflow. Untick "Wrap text" for the strict
single-line view; that choice is remembered per browser.

**On a phone** (viewport 640px or narrower) both of those open up, because a
grid laid out for a desktop leaves almost every column too narrow to read:

- every column is a quarter wider, and never narrower than 130px, so the short
  ones stop cutting off mid-word;
- but never wider than the screen — growth is capped at the viewport less the
  row-number gutter, since a cell you have to scroll sideways *through* is worse
  than a short one. Leases' 360px Comment column is the one that hits this;
- every column shows **at least two lines**. A column asking for more keeps it,
  so Personal Opinion stays at three;
- the row-number gutter narrows to 34px and the keyboard-shortcut bar is hidden,
  both of which are just space a phone can't spare.

Widths and line counts are computed rather than styled, so the redraw is driven
by a resize listener rather than the media query — rotating a phone or dragging a
desktop window across the breakpoint re-renders, except mid-edit, which would
throw away what's being typed. The 640px breakpoint appears in two places, the
stylesheet and `NARROW_MAX` in the script; they have to stay in step.

Apart from the rule below, none of this changes the desktop view, which is still
one line per cell.

### Values that are never shown in part

Half a phone number is not a shorter answer, it's a wrong one. Columns whose
`type` is `phone`, `date`, `time`, `code`, `unit` or `datetime` are therefore
drawn **at least as wide as their longest value, at every screen width** — the
column can be set narrower by hand, but it won't be drawn narrower. They also
break between groups rather than mid-digit, so a number never reads as a
different number across two lines.

The fit is measured with the grid's own font through a canvas, not guessed from
a character count, so it stays right if the font changes. Where canvas isn't
available it falls back to a rough per-character estimate.

This matters most at the sizes *between* a phone and a desktop — a tablet, or a
phone held sideways — which are wider than 640px and so get the desktop layout
with its single line per cell. Below the breakpoint the flat widening usually
covers these columns anyway.

Text columns are untouched by this: prose is readable in part, and what it needs
is lines, not width.

### What a cell shows vs. what it holds

Two columns are displayed shortened. The sheet still stores the full value —
opening a cell to edit, search, copy and the CSV export all see the original, and
a shortened cell carries the whole thing as a tooltip.

- **Addresses** (`type: "address"`, currently just Location) lose the state and
  the country: `12 Example Ave NE, Springfield, ST 12345, USA` shows as
  `12 Example Ave NE, Springfield, 12345`. The zip stays. Only uppercase state
  abbreviations are recognised, so a lowercase word like "in" or "or" can't be
  mistaken for one, and a Location that isn't an address ("From 6 to 10:30")
  is left exactly as typed.
- **Dates** (`type: "date"` — Location aside, that's Tours' Date and Leases'
  Start/End) show `YY-MM-DD`: `2026-07-27` reads as `26-07-27`. Anything not in
  `YYYY-MM-DD` shape is left alone, and the stored value keeps its century.

Both rules key off the column's `type`, not its name, so renaming a column
doesn't change how it's shown.

### Two people editing at once

Until 2026-08-05 a sheet page kept the whole document in memory and wrote *all
of it* back on every save — including the sheets it wasn't showing, and
including a copy that might be hours old. Whoever saved last won, silently.

That is how a day of tour entries went missing. A page opened around 02:00 sat
in a tab until 19:25, when closing it fired the `pagehide` save; that write put
the sheet back to its 02:00 state and took three rows with it — the tours added
at 02:52, 02:53 and 03:00. Nobody was told, and the page that lost the rows had
been showing them correctly all day. One row (a 4:00PM tour of 56 Poplar Ave NE
under a group booking, carrying four phone numbers) was recovered out of the SQLite
write-ahead log and put back; the rest had already been re-typed by hand.

Three things now stand between that and a repeat:

- **A page saves only the sheet it is showing.** A tab open on Tours can no
  longer write anything to Leases or Vendors.
- **Every save carries the `rev` the page loaded with**, and the server refuses
  the whole request with `409` if the stored rev has moved on. Nothing is
  written and nothing is lost: the page keeps the edits on screen and offers
  **Keep both** (take the server's rows and append the ones only this page has —
  the right answer when two people are adding tours) or **Mine wins**. A page
  that has gone stale in a forgotten tab now gets refused instead of obeyed,
  and that includes its parting `pagehide` save.
- **A page catches up on its own** when it comes back to the foreground, as long
  as nothing is unsaved and no cell is open — so a tab left open all day stops
  being a loaded gun.

Every accepted save is also copied into `sheet_versions` (the last
`SHEET_VERSIONS_KEPT` = 60 states per sheet, with who saved each). Recovering
from a bad save is now a query rather than a dig through the WAL:

```sh
sqlite3 crm.db "SELECT rev, row_count, saved_by, saved_at
                  FROM sheet_versions WHERE sheet_id='tours' ORDER BY id DESC LIMIT 10;"
```

### What a date column stores

A `type: "date"` column stores ISO (`2026-08-03`) whatever shape the date was
typed or pasted in, and only *shows* it shortened. That's what makes the sort
chronological, since dates are compared as text.

Typing into one is converted on the way in: `08.03.26`, `8/3/26`, `08/03/2026`
and `2026/8/3` all store as `2026-08-03`. Two-part-then-year is read US-style,
month first — `03.08.26` is 8 March, not 3 August — because a day-first date is
indistinguishable from a month-first one, and this is how the sheet's dates are
written and shown back. A value that isn't a date at all ("TBD", or a half-typed
one) is stored exactly as typed rather than guessed at, and an impossible date
like `08.32.26` counts as not-a-date.

Sorting a date column sorts on the ISO reading of each cell rather than on its
text, so an odd value that reaches the column some other way still lands in the
right place. Blanks sink to the bottom either direction, as in any column.

Tours' Date held both shapes until 2026-08-05: it displays `MM.DD.YY`, so rows
typed in afterwards were saved as `08.03.26` and sorted below every `2026-…`
row, which is what "the dates aren't sortable" was. The 11 rows holding that
shape were rewritten to ISO (`crm-backup-2026-08-05-pre-datefix.db` is the copy
taken first), and conversion-on-entry is what stops it coming back.

### Lease term shading

On **Leases**, the Start and End cells of a row are shaded by where today falls
in the term, so an active lease can be picked out without reading two dates:

| Shade | When |
| --- | --- |
| Light green | Start ≤ today ≤ End — the lease is running |
| Grey | End is in the past — the term has finished |
| Light yellow | Start is in the future — the term hasn't begun |

Both ends count as inside the term, so a lease is still green on its last day.
A row is left unshaded when the pair doesn't describe a real term: either date
blank, either not in `YYYY-MM-DD` shape, or End before Start. Today is taken in
the browser's own timezone, and the comparison is a plain string one against the
stored ISO dates.

Which two columns make the pair is marked on the columns themselves —
`"range": "start"` and `"range": "end"` alongside `name`/`type`/`width`, on
Leases' Start and End. Like the display rules above this is keyed off the
column rather than its name, so renaming Start or End doesn't stop the shading;
any other sheet given a marked `date` pair gets the same behaviour. Selecting a
shaded cell still shows the selection colour over the shade.

### Vendors

A third tab, added 2026-07-29: **Name, Phone, Email, Scope of Work, Location,
Comment**. It starts empty — there were no vendor records anywhere in the app to
carry over. Use "+ Row" to add one; the Comment column is where anyone can say
what they thought of a job.

**Anyone signed in can add a vendor or comment on one** — unlike the tenants
page, which only the owner can change. That isn't a new permission, it's how `/sheets`
has always worked, and every save is logged with the username. Tested with the
`harsh` and `andy` accounts adding vendors and commenting on each other's rows.

Phone is a `phone` column, so a number is never cut off. Location is an
`address` column, so it hides the state and country like Tours' Location does.
Scope of Work and Location show two lines, Comment three.

**One caution, and it matters more now that everyone is editing.** A save `PUT`s
every tab at once, and the server deletes any tab the payload leaves out. Two
people editing different tabs in different browsers means last-writer-wins, and a
page loaded *before* a tab existed will delete that tab when it next autosaves.
So: reload `/sheets` after any tab is added, and don't leave it open for days.

Tours & Prospects has a **Tour Guide** column, added 2026-07-27 and defaulted to
the only guide at the time on all 90 rows that have content. The one fully blank row was left blank.

Its **DateTime** column was removed on 2026-07-28. It held `2026-07-24 12:30 PM`
on 21 of 93 rows, always agreeing with that row's Date and Time and never the
only record of either, so nothing went with it. `crm-backup-2026-07-28-pre-sheets.db`
is the snapshot taken immediately before.

## Tour calendar events

Adding a row to **Tours & Prospects** books a Google Calendar event for it. The
event is created by the office Google account, and invites
the standing guest list (`CALENDAR_STANDING_GUESTS`) plus whoever is in the
row's Tour Guide column.

    <number> <prospect> <> <guide>              12 Marcus <> Lee
    <number> #<unit> <prospect> <> <guide>      78 #310 Priya <> Lee (Virtual)

The title carries only the street number, plus a unit where there is one: it
is read in a crowded day view, where the number is the whole of what tells one
property from another, and it sidesteps how the sheet capitalises a street.
The location field and the description keep the full postal address.

The description carries the prospect's phone and the basics off the row —
occupation, lease type, source, status, host, in-person or virtual, the full
address, and the notes. Tours are **30 minutes** unless the row fills in End
Time, and always in the property's own zone, since every property is in one city.
A row with a date but no time is booked as all-day; a row missing a name, a
location or a date is not booked at all, which is what keeps the sheet's blank
spacer rows off the calendar.

Two things are read out of prose rather than a column, because the sheet has no
column for either. A tour counts as **virtual** when its notes say so
("virtual", "Zoom", "FaceTime", "video tour"). And `12:50PM (1:10PM actual)`
books the time outside the brackets, with what was inside it kept in the
description as a time note.

### How it gets to Google

`server.ts` cannot talk to Google on its own. A **Google Apps Script web app**,
deployed under the office account, does the creating; the CRM posts to it with
a shared secret. Apps Script runs *as* the deploying account, so the event is
owned by that account and the invites come from it — with no OAuth client to
register and no refresh token stored on this box.

`google-apps-script/tour-calendar.gs` is the copy of record for what is
deployed, and carries its own deployment instructions. Set both of these in the
service environment, then restart:

    CALENDAR_WEBHOOK_URL=https://script.google.com/macros/s/…/exec
    CALENDAR_WEBHOOK_SECRET=<the same string as SECRET in the .gs file>

With them unset the feature is off: tours are still queued, nothing is sent,
and the boot log says so. Setting them later sends the backlog.

### Why it is a queue

Posting happens **after** the save has committed, never inside it. A tour
safely on the sheet but missing an invite is a nuisance; a save refused because
Google was slow would be a lost tour. Failures are retried on a 30-second loop
and give up after six attempts, leaving the row to be looked at.

`tour_events.key` is a hash of prospect + property + **date**, and is the
primary key, which is the whole dedupe. It matters because the sheets API saves
the entire tours sheet on every keystroke, so every tour is seen again on every
save. Deliberately not keyed on time: a tour moved by an hour is the same tour,
and re-keying on time would book a second event every time somebody nudged one.
Nothing is keyed on row position either, or the first person to sort the sheet
would re-invite everybody.

### Editing a tour

Editing a booked tour updates its event in place rather than making a new one —
a new time, a different guide, a different property, a corrected name. The
guide who is no longer on the tour is uninvited and the new one invited; the
rest of the guest list is left alone, because removing and re-adding somebody
re-sends the invitation and throws away the answer they had already given.

Changing the **date** changes the tour's key, so an edited row looks like one
tour disappearing and another arriving. Both halves are visible in the same
save, and a tour that vanished is paired with one that arrived when they agree
on two of {prospect, property, date} — that's `pairRekeyed`, and it is what
keeps a date change an update instead of a duplicate. Only rows that actually
vanished are candidates, which is what keeps a genuine re-tour safe: when
a prospect tours again on the 12th their row from the 9th is still there, so there is
nothing to pair with and the second tour books its own event.

Adding a **second line** for the same prospect, property and day — rather than
editing the first — is read as a reschedule, and moves the original event to
the new time. The later entry wins.

A tour **removed** from the sheet keeps its event, and the removal is logged.
Cancelling somebody's meeting because a row was deleted, or because a stale
page saved over it, is not a call this should make on its own.

### From the command line

    bun run calendar status                       # config, and what's queued
    bun run calendar guides                       # the guide -> email map
    bun run calendar guides set Lee lee@example.com    # the sheet only holds first names
    bun run calendar queue [--all]                # failures first
    bun run calendar retry <key>|--all
    bun run calendar test                         # book a throwaway event
    bun run calendar backfill 2026-08-01          # tours already on the sheet

A guide with no address on file still gets an event — it just goes to the
office mailbox alone, and the miss is logged and shown by `calendar status`.

Tours already on the sheet were never "added" while this was running, so
nothing queued them; `backfill` is how they get booked.

## Driveway plates

Cars parked in the driveway that shouldn't be, at `/plates`. The point of the
page is the **repeat**: one neighbour blocking the drive once is an accident,
the same plate four times is a pattern worth acting on.

The form starts filled in, because almost every report is the same driveway and
the same complaint — the common visit should be one field and a button. The
state, the location and the note it opens with are settings, not source: which
driveway a company watches is its own business.

    bun run plates defaults
    bun run plates defaults --state WA --location "12 Example Ave NE" --notes "Blocking garage"
    bun run plates repeats            # only the plates seen more than once

A report is a plate, a state, and optionally where the car was, a note, and up
to two photos — the plate itself and a wider shot showing where it sat. The
date is today's, taken in the property's timezone rather than the server's, and
is not something anyone types.

### Why the plate is stored twice

`plate` is normalised — upper case, letters and digits only — and indexed.
`plate_typed` is what the person actually entered. People write the same plate
differently every time (`7ABC123`, `7abc-123`, `7 ABC 123`), and a repeat that
doesn't collide is a repeat nobody sees; but what somebody wrote down is
evidence and shouldn't be quietly rewritten, so both are kept.

Matching is on the plate alone, not plate and state. A plate is only truly
unique within its state, but two states issuing the same number *and* both
parking in one driveway is vanishingly unlikely, while somebody guessing the
state wrong is not. Where a plate has been logged under more than one state,
the row says so.

### The red

A row is red when its plate has been seen before, and carries `REPEAT · 2 of 3`
— which sighting this is, and how many there are. The first sighting of a
repeated plate stays uncoloured but is labelled `first of 3`, so the history
reads in order. Colour is never the only signal: the badge says the word.

### Photos

Stored under `uploads/plates/` (gitignored — they are pictures of other
people's cars). The filename is a uuid this app generates plus an extension it
chose from the type it recognised, so nothing from the browser reaches the
path. Serving them goes through the sign-in like every other route.

Either all of a report's photos are written or none are: a valid first photo
alongside a rejected second one used to leave a file on disk that no report
pointed at, which nothing would ever clean up.

Deleting is soft. A report used to ask somebody to stop parking there shouldn't
be able to vanish without trace, so the row stays with `deleted_at` set and
leaves the page.

## Inspections

The move-in condition checklists are filled in and signed in a **separate app**
(`checklist/`, on :3100). That app has no sign-in — the one page it serves is a
link handed to a tenant — so it deliberately has no route that lists everyone's
reports. This is where that list belongs instead: behind the CRM's sign-in, on
`/inspections`.

`inspections.ts` opens `checklist/checklists.db` **read-only**. Nothing here
writes to it; a checklist only ever comes into being by a tenant signing one.
The connection is opened on first use rather than at boot, so a missing or
unreadable checklist database costs that page alone — the door codes on `/`
still come up, which is the half of this app somebody is looking at when a
door won't open.

The list gives each report its date, property, tenant, agent, how many rooms and
items it covers, how many items were marked **poor** or left blank, what photos
and videos came with it, and how many comments have been added since it was
signed.

**Defects & notes** is a column of its own, and it is the reason the page
exists: every item rated Poor or Fair with the note that came with it, worst
first, then everything else that was written — a note against an item nobody
faulted, a room's own note, and the general notes about the property. It's in
the row, not behind a click, so twenty reports can be read down in one pass. A
report with neither says "nothing flagged, nothing written."

The identifying columns are squeezed to give it the width: bedrooms, baths,
rooms and item count sit under the address, the agent under the tenant, and the
condition, media and comment pills share one **Flags** column.

One walkthrough of a nine-bedroom house recorded 46 findings, so a cell longer
than four lines is clamped with a **Show all N** under it, and **Show all
findings** in the toolbar unclamps the page. The clamp is CSS — the text is
still in the row, so the browser's own find still hits it, and so does the
filter box: typing `dishwasher` or `smoke detector` finds the report somebody
half remembers and unclamps what it says, as well as matching property, tenant,
agent and date.

Opening a report shows every room and item with its notes, a **Marked
poor** summary at the top when there is anything to answer for, the photos and
videos, both signatures, and the certification wording as it stood on the day it
was signed.

The PDF and the attachments are served through this app, from the checklist
app's own `pdfs/` and `uploads/` directories, so nobody on the team needs to be
able to reach :3100. If a PDF has gone missing from disk, the checklist app is
asked for it — it rebuilds one from the stored answers.

### Comments added after signing

Somebody always learns something after the walkthrough — a repair gets booked, a
tenant emails about a window that still sticks, a quote comes in. That belongs
with the inspection, so each report takes comments: anyone signed in can add
one, and it goes out with their name and the time on it.

**A comment never changes the signed checklist.** The PDF in
`checklist/pdfs/` is the document the tenant and the agent put their names to,
and a record that can be edited afterwards is worth nothing in a deposit
dispute. So:

- The comments live in the CRM's own `inspection_notes` table. Nothing here
  writes to `checklists.db`, which is opened read-only.
- The file on disk is never rewritten. `?original=1` serves it byte for byte as
  it was signed — that's the version to hand over if anyone ever has to prove
  what was actually certified.
- On `/inspections/:id.pdf` the comments are appended as an **addendum**, on
  pages after the signature, built onto a copy as the PDF is served
  (`addendum.ts`). Those pages say in as many words that they were added after
  signing and that nobody signed them, and each comment carries its author and
  timestamp. The download is named `..._with-comments.pdf` so it can't be
  mistaken for the signed copy once it's in somebody's downloads folder.
- The signed pages keep the footers they were signed with. "Page 2 of 5" on a
  document that is now seven pages long is the truth about what was signed; the
  addendum numbers itself separately, in red, and says what it is.

Removing a comment is limited to whoever wrote it, or the owner, and it's a soft
delete — it stops printing and stops showing, but a comment that has already
gone out on a PDF shouldn't leave no trace of having existed. `author_name` is
stored as it was at the time, so renaming an account doesn't rewrite an old
addendum.

Override the paths with `CHECKLIST_DIR` (or `CHECKLIST_DB`, `CHECKLIST_PDF_DIR`,
`CHECKLIST_UPLOAD_DIR` individually), the rebuild address with `CHECKLIST_URL`,
and the timezone the signing times are read in with `CHECKLIST_TZ` — it defaults
to `America/Los_Angeles`, because the properties are here.

## The doc pages

`doc.ts` reads a raw Google Docs export and rebuilds it as semantic HTML:
bold/italic recovered from the generated stylesheet, flattened `lst-kix_*-N`
lists re-nested into real `<ul>` trees, Google redirect URLs unwrapped, shaded
bordered paragraphs kept as callout boxes, and tables given headers, mailto/tel
links and a Vacant pill. Re-export a doc over its file and the page picks the
changes up on next load — no re-styling needed.

Two documents use it:

| Where it shows          | File                                  | Sections            |
| ----------------------- | ------------------------------------- | ------------------- |
| `/`, under the access table | `home-unit-information.html`      | one per property, then Application and FAQ |
| `/workflow`             | `prospect-management-workflow.html`   | one per phase       |

Home/Unit had a page of its own at `/doc` until 2026-08-10, when it was merged
into the access page: contents, the access table, shortcut cards, the property
sections, then Application and FAQ. `doc.ts` exports the parts (`docSections`,
`sectionHtml`, `DOC_CSS`) so `server.ts` can lay that out itself; `/doc` still
redirects to `/#homes` for old links. The access table's styling is scoped to
`#access` because the two halves' stylesheets both claim `table` and
`.table-wrap`, and the unit tables inside the home sections must keep the
document's.

The exports don't agree on heading levels — Home/Unit puts its title in an `<h1>`
and its sections in `<h2>`, while the workflow doc has no `<h2>` at all and uses
`<h1>` for sections — so the section level is **detected per document** rather
than assumed. Everything else that differs (title, the line under it, which
sections get a card and what the card says) is a per-page option, which is what
`renderWorkflowPage` fills in over the shared renderer.

### Prospect Management Workflow

Added 2026-07-30 from [this doc][workflow-doc]: the three phases (Initial
Outreach, Property Tour, Post-Tour Engagement), each carded with its stated Goal.
The example message to send a prospect is a shaded box in the doc and stays a
callout here.

[workflow-doc]: https://docs.google.com/document/d/1VVB1kEt2DA25dV55In7qCThPpOKEqoURDhKMAyxOSrI/edit

**This is a copy, not a live link** — same as `/doc`. Editing the Google Doc
won't update the page; re-run the export over
`prospect-management-workflow.html`:

```sh
curl -sL "https://docs.google.com/document/d/1VVB1kEt2DA25dV55In7qCThPpOKEqoURDhKMAyxOSrI/export?format=html" \
  -o prospect-management-workflow.html
```

One thing to know if you compare the page against the doc: the two cases under
Phase 3 read "1: They liked tour…" and "2: They did not like tour", with no
"Scenario" label — that word isn't in the document, so it isn't on the page.

## Sheets data

The data was imported from the Google Sheet linked in the page header;
`data/sheets.json` is the import artifact (Excel serial dates, fractional times and
float phone numbers already normalized to readable strings).