# Property Condition Checklist

A tenant fills in a move-in condition report on their phone, signs it, and gets
a PDF. Runs on **:3100**, separate from the CRM on :3000.

```
bun run start          # or: bun run dev   (reloads on change)
```

| Route                    | What it is                                          |
| ------------------------ | --------------------------------------------------- |
| `/`                      | The whole app — one page, three steps                |
| `/?copy=<checklist id>`  | The same page, started as a copy of an earlier report |
| `/api/templates`         | Room templates, condition names, the count cap       |
| `/api/rooms?bedrooms=&bathrooms=` | The starting rooms for those counts         |
| `/api/checklists`        | `POST` a signed checklist → `{ id, pdf }`            |
| `/api/checklists/:id/copy` | What a signed checklist says, as the start of another |
| `/checklists/:id.pdf`    | The PDF, rendered on request from the stored answers |
| `/api/health`            | `{ ok: true }`                                       |

## Why it's a separate app

The CRM holds tenant records and door codes behind a sign-in. This is the one
page a tenant is sent a link to, so it lives on its own port, in its own
database (`checklists.db`), with no access to any of that. It has **no
authentication** — see "Before this goes anywhere public".

## The three steps

1. **Details** — tenant full name, email, address, steppers for bedrooms and
   bathrooms (0–12 each), a **furnished** tick, and an optional **agent full
   name**. Steppers rather than a numeric keypad: the answer is almost always
   under five, and a keypad on a phone covers the form.
2. **Checklist** — one collapsible card per room, each opening with a one-line
   **room note**: which bedroom this is, where the bathroom is off. "Bedroom 2"
   tells a reader nothing six months later; "small back bedroom off the
   hallway" does. The prompt suits the room kind, it's styled quietly so it
   doesn't read as another thing to fill in, and it prints under the room's
   heading in the PDF. Then each item is rated
   Excellent / Good / Fair / Poor / N/A with optional notes. Rooms can be
   removed from their header and items from their row; both can be added.
   **Mark all good** fills a room in one tap, and only touches items that
   haven't been answered — a Poor recorded on the way round isn't wiped by the
   shortcut, and the page says how many it left alone. Tapping the selected
   condition again clears it, so a mis-tap isn't permanent. Each room header
   counts how much of it is done.
   The last section on this step belongs to no room: **general notes** for
   anything about the property as a whole, and **photos and videos**. Files
   upload as they're picked rather than all at once at signing — a walkthrough
   happens on cell data, and a video that uploads while the next room is being
   checked is already there at the end. Photos are redrawn to 1600px JPEG in
   the browser first, which cuts a 5 MB camera picture to a few hundred KB and
   normalises whatever the camera produced into something the PDF can embed.
   Continuing is blocked while an upload is in flight.
3. **Review and sign** — a summary, a tally (rated / poor / left blank), the
   certification, and signature canvases backed at device pixel ratio so a
   finger or stylus line is sharp. Submit renders the PDF and hands back a link.

The name field **suggests** "Dan Zhu" as a placeholder rather than filling it
in: the field starts empty, so a name only reaches a signed checklist by being
typed.

## Move-in and move-out: copying a checklist

A property gets walked twice — once when a tenant moves in and once when they
move out — and the second walkthrough is really the first one re-checked. Typing
the address, the rooms and everything recorded about them again is how a
move-out report ends up describing a slightly different property from the
move-in report it is supposed to be compared against.

So the page can start as a copy of a checklist that has already been signed.
Open it as `/?copy=<checklist id>` — the link the CRM puts on every signed
report — and it comes up with:

- the **property**: address, bedroom and bathroom counts, furnished or not;
- the **agent** who walked it;
- every **room**, with the condition and the note each item carried, and the
  room's own note;
- the **general notes**;
- the **photos and videos**, referred to again rather than uploaded a second
  time. Both checklists point at the same file, which is why the boot-time
  sweep only deletes an upload nothing refers to.

What does not come over is anything that made the first one a record: no
signature, no certification, no signing time. Those are made afresh, by whoever
is standing in the property today.

The **tenant's name and email come with it**, because it is usually the same
tenancy — and the name field is focused and selected the moment the page opens,
because when it isn't the same tenant that is the first thing to change.

The copy is a new checklist, not an edit of the old one. It takes its own draft
id, so nothing typed into it lands on a draft somebody else is still filling in,
and the signed report it came from is never touched — this app has no route that
changes one. A checklist already in progress on the phone is not thrown away
without being asked about first.

Once the copy is made the `?copy=` is taken out of the address bar. A reload has
to bring back what has been typed since, not make the copy again — and
pull-to-refresh is one careless swipe.

The banner at the top says which checklist it came from and who signed it, in a
different colour from the "picked up where you left off" one: until the property
has actually been walked, what is on screen is last time's walkthrough.

## Not losing the work

A walkthrough is twenty minutes of typing on a phone, and reloads are not rare
here: opening the camera for a photo leaves the browser, and a phone under
memory pressure discards the backgrounded tab and reloads it on the way back.
Pull-to-refresh does the same in one careless swipe.

So everything typed is written to `localStorage` as it's typed — debounced, and
**synchronously on `visibilitychange`/`pagehide`**, which is the last moment
before a tab is discarded and therefore the write that actually matters. On
load, a draft under 7 days old is restored with a banner saying when it was
saved and a "Start fresh" way out. `overscroll-behavior-y: contain` disables
pull-to-refresh, and a `beforeunload` guard covers a deliberate reload on
desktop (mobile browsers often ignore it, which is why autosave is the real
answer).

**The same draft also goes to the server**, under an id the page makes once and
keeps, updated in place every few seconds and on the way out (`PUT
/api/drafts/:id`). The browser copy is on one phone: when a tenant couldn't
submit, twenty minutes of work existed nowhere else, and nobody could see it or
finish it for them. Now the answers are off the phone long before anyone
presses a button, and a header dot says so — green with the time it saved,
amber while saving, red if the server can't be reached.

A draft is **not** a report: no signature is stored with it and nobody has
certified anything, and it only becomes a checklist through the normal signed
route. `GET /api/drafts/:id` reads one back, signing deletes it, and drafts
untouched for 60 days are removed at boot. Each new draft logs its id and
address, so an unfinished walkthrough can be found without a listing endpoint —
this app has no sign-in, and a list of everyone's in-progress checklists is not
something it should hand out.

Photos survive because they're already uploaded: the draft keeps their ids and
the thumbnail is redrawn from `/uploads/:id.:ext`, since the `blob:` URL from
the original pick dies with the page.

**Signatures are deliberately not kept.** Everything else is a description of a
room; a signature is someone putting their name to it, and has to be made
rather than restored from storage. A restored checklist resumes at the room
step, never on the signature step.

The draft is cleared when the checklist is signed, and when "Start fresh" or
"Start another checklist" is used. A stale, corrupt, or wrong-version draft is
discarded rather than half-applied.

## Certification and signatures

`legal.ts` holds the certification and the acknowledgements. Both are served to
the page and **stored on each submission**, not merely referenced — so a
checklist signed today still prints the wording that was on screen today, even
after that file changes.

- The certification must be ticked. It is checked on the server too, so it
  can't be skipped by posting straight at the endpoint, and the PDF draws a
  ticked box rather than describing one.
- The tenant always signs. The agent is named on the **first** page and both
  their name and their signature are optional, giving three outcomes the PDF
  prints differently:

  | On the form | In the PDF |
  | --- | --- |
  | Agent named and signed | their mark, name, role and date |
  | Agent named, not signed | a ruled line with their name and "Not signed electronically" — ready to sign on paper |
  | No agent named | a faint ruled line, "no agent present at inspection" |

  A signature with **no** name is rejected at both ends: a countersignature
  nobody can identify is worse than none. Clearing the agent name and going
  back to the signature step also clears any signature already drawn, so the
  two can't disagree.

> **Not drafted by a lawyer.** Washington's Residential Landlord-Tenant Act
> (RCW 59.18.260) requires a written checklist describing the condition of the
> property, **signed by both landlord and tenant**, whenever a deposit is
> taken. Whether the agent signature can be optional under that section — and
> the wording in `legal.ts` generally — is worth an attorney's eye before this
> is relied on in a deposit dispute.

Rooms come from `rooms.ts`: one template per kind, so a kitchen is asked about
its dishwasher and a bedroom about its closet. Every checklist starts with a
room per bedroom and bathroom, plus living room, kitchen, hallway and exterior
premises. They're a starting point only — the submission carries whatever the
tenant ended up with, which is what the PDF prints.

**Furnished** adds a Furnishings section, last, built from the rooms the
property actually has (`furnishingItems`): a bed and a desk per bedroom, then
cookware / ceramicware / silverware if there's a kitchen, and a couch and
table/chairs if there's a living room. With one bedroom the items read "Bed"
and "Desk"; with two or more they're named per room, "Bed (Bedroom 1)". A
property with none of those rooms gets no section rather than an empty heading.
The tick is read when the list is built, so changing it and continuing rebuilds
the checklist — as changing the bedroom or bathroom counts already does.

## The PDF

`pdf.ts` lays the document out by hand with `pdf-lib` rather than printing the
page: this is the copy both sides keep, so it has to paginate the same way
every time and carry the same wording, which a print stylesheet across phone
browsers does not.

Notes worth knowing:

- The standard PDF fonts are WinAnsi-encoded and `pdf-lib` throws on a
  character it can't encode, so a curly quote pasted from a phone keyboard
  would otherwise fail the whole document. `winAnsi()` folds what has an
  obvious equivalent and drops the rest.
- An unrated item prints as `-`, never as a blank, so a skipped line can't be
  mistaken for one the printer dropped. Anything marked **Poor** prints in red
  and bold.
- The signature is scaled to fit its box without stretching, and the
  acknowledgement block is kept whole on one page.
- The PDF is **rendered and written to disk before the row is stored**. A
  submission that can't be turned into a saved document is rejected rather than
  kept as a record with no copy — which is how a corrupt signature is caught
  (there's a test for it).

`Content-Disposition` is `inline`, not `attachment`: on a phone that opens the
system PDF viewer, where "share" and "save to files" both live. Downloading
straight to storage hides the file.

## Storage

Two things are kept, and both are the record:

**`pdfs/`** (override with `PDF_DIR`) — the signed copy of every checklist,
written the moment it is signed. Named to sort and to read without opening:

```
pdfs/2026-08-14_121-12th-Ave-E_Dan_006d87be.pdf
     └ date     └ property       └ tenant └ first 8 of the id
```

The file on disk is what `/checklists/:id.pdf` serves — it's the artefact the
tenant signed, so it does **not** silently change when the layout in `pdf.ts`
does. Delete a file and the next request rebuilds it from the stored answers
(and says so in the log).

**`uploads/`** (override with `UPLOAD_DIR`) — the attached photos and videos,
each named from the id the server issued and the type it actually is, never
from what the browser called it. `POST /api/uploads` stores one file and hands
back an id; the submission at the end only refers to those ids, and a reference
with no file behind it is rejected rather than printed as a missing photo.

Photos are embedded in the PDF, two to a row, scaled to keep their shape.
Videos can't be — they're listed by name and size under a line saying they're
kept with the record, and `GET /uploads/:id.:ext` serves any of them back.

Uploads outlive checklists that were never signed (someone takes six photos and
closes the tab), so **at boot anything older than a day that no stored
checklist refers to is deleted**. The age limit is what keeps a file still
sitting in a form on someone's phone safe.

**`checklists.db`** (override with `DB_PATH`) — SQLite, one row per checklist:
the everyday fields as columns so the table is queryable, the whole submission
as JSON in `data` so any checklist can be re-rendered later even after the room
templates in the code have moved on, and `pdf_file` naming its saved copy.

Back up `checklists.db`, `checklists.db-wal` and `checklists.db-shm` together —
it's in WAL mode, so recent writes sit in the `-wal` file until SQLite
checkpoints and copying only the `.db` can miss them.

Every checklist is checked for a saved copy **at boot**, so anything submitted
before this app kept them — or during any window where the disk was
unwritable — gets written on the next start. It logs one line either way.

## Before this goes anywhere public

- **There is no authentication and no rate limit.** Anyone who can reach the
  port can submit a checklist. That's the right shape for a link handed to a
  tenant, and the wrong shape for the open internet.
- PDF links are unguessable (a random UUID) but not secret: anyone with the
  link can open that checklist. Treat the link as the credential.
- It binds to `127.0.0.1` by default. `HOST=0.0.0.0` exposes it — don't, until
  the two points above are settled.
- Submissions are capped (4 MB body, 40 rooms, 60 items per room, 1000-character
  notes) so one POST can't produce a thousand-page document.

## Keeping it running

`bin/checklist-tmux.sh` starts it in a tmux session called `checklist` with a
restart loop, the same pattern the CRM uses. It is **not** in cron yet; to have
it come back after a reboot:

```
(crontab -l; echo '@reboot /workspace/checklist/bin/checklist-tmux.sh';
            echo '* * * * * /workspace/checklist/bin/checklist-tmux.sh') | crontab -
```
