/**
 * The signed move-in condition reports, read out of the checklist app.
 *
 * That app (checklist/, on :3100) is deliberately separate: it has no sign-in,
 * because the one page it serves is a link handed to a tenant. So the list of
 * everyone's inspections can't live there — it lives here, behind the CRM's
 * sign-in, and this module opens `checklists.db` **read-only**. Nothing in the
 * CRM writes to it: a checklist is only ever created by the tenant signing one.
 *
 * The PDF and the photos are served through here too, so a team member reading
 * the list never has to be able to reach :3100 themselves.
 */
import { Database } from "bun:sqlite";
import { PDFDocument } from "pdf-lib";
import { appendAddendum, type AddendumNote } from "./addendum";
import { canEditTenants, displayName, FAVICON_LINK, type User } from "./auth";
import { db } from "./db";

/** All three live side by side under the checklist app's directory. */
const CHECKLIST_DIR = process.env.CHECKLIST_DIR ?? "checklist";
const CHECKLIST_DB = process.env.CHECKLIST_DB ?? `${CHECKLIST_DIR}/checklists.db`;
const PDF_DIR = process.env.CHECKLIST_PDF_DIR ?? `${CHECKLIST_DIR}/pdfs`;
const UPLOAD_DIR = process.env.CHECKLIST_UPLOAD_DIR ?? `${CHECKLIST_DIR}/uploads`;

/**
 * Only used when a PDF is missing from disk: the checklist app rebuilds one
 * from the stored answers on request, and that's a better answer than telling
 * someone the copy is gone.
 */
const CHECKLIST_URL = process.env.CHECKLIST_URL ?? "http://127.0.0.1:3100";

/** The properties are all in Seattle, so that's where a signing time is read. */
const TIME_ZONE = process.env.CHECKLIST_TZ ?? "America/Los_Angeles";

type Attachment = { id: string; name: string; kind: "photo" | "video"; mime: string; size: number };
type Item = { label: string; condition: string; notes: string };
type Room = { kind: string; name: string; notes: string; items: Item[] };
type Checklist = {
  id: string; name: string; email: string; address: string;
  bedrooms: number; bathrooms: number; rooms: Room[];
  generalNotes: string; attachments: Attachment[]; signature: string;
  certification: string; acknowledgements: string[]; signedAt: string;
  agentName?: string; agentSignature?: string;
};
type Row = { id: string; created_at: string; address: string; pdf_file: string | null; data: string };
type Inspection = { id: string; createdAt: string; pdfFile: string | null; checklist: Checklist };

/**
 * The connection, opened on first use and kept. Lazily rather than at boot so a
 * missing or unreadable checklist database costs this one page rather than the
 * whole CRM — the door codes on `/` have nothing to do with inspections and
 * must still come up.
 */
let handle: Database | null = null;
function checklistDb(): Database | null {
  if (handle) return handle;
  try {
    const db = new Database(CHECKLIST_DB, { readonly: true });
    // Prove the table is there now, rather than throwing inside a page render.
    db.query(`SELECT 1 FROM checklists LIMIT 1`).get();
    handle = db;
  } catch (err) {
    console.warn(`Could not read ${CHECKLIST_DB}; the inspections page will say so.`, err);
    handle = null;
  }
  return handle;
}

/** A stored row, or null if it isn't one we can make sense of. */
function toInspection(row: Row): Inspection | null {
  try {
    const checklist = JSON.parse(row.data) as Checklist;
    if (!checklist || !Array.isArray(checklist.rooms)) return null;
    return { id: row.id, createdAt: row.created_at, pdfFile: row.pdf_file, checklist };
  } catch {
    console.warn(`Skipping checklist ${row.id}: its stored answers aren't readable JSON.`);
    return null;
  }
}

function listInspections(): Inspection[] | null {
  const db = checklistDb();
  if (!db) return null;
  try {
    // Newest first: the reason to open this page is almost always the
    // walkthrough that happened this week.
    const rows = db
      .query(`SELECT id, created_at, address, pdf_file, data FROM checklists ORDER BY created_at DESC`)
      .all() as Row[];
    return rows.map(toInspection).filter((i): i is Inspection => i !== null);
  } catch (err) {
    console.warn("Could not list the checklists.", err);
    return null;
  }
}

function readInspection(id: string): Inspection | null {
  const db = checklistDb();
  if (!db) return null;
  try {
    const row = db
      .query(`SELECT id, created_at, address, pdf_file, data FROM checklists WHERE id = ?`)
      .get(id) as Row | undefined;
    return row ? toInspection(row) : null;
  } catch (err) {
    console.warn(`Could not read checklist ${id}.`, err);
    return null;
  }
}

/* --------------------------------------------------------------------- notes */

/**
 * Comments the office adds to a signed inspection. They live in the CRM's own
 * database — `checklists.db` is read-only to this app, and a checklist is what
 * the tenant signed, not a thread. On the PDF they print as an addendum after
 * the signed pages; see addendum.ts for why they never print among them.
 */
export type Note = AddendumNote & { deletedAt: string | null };

/** Long enough for a paragraph of context, short enough to stay a comment. */
export const NOTE_MAX = 4000;

const insertNote = db.query(
  `INSERT INTO inspection_notes (checklist_id, body, author, author_name, created_at)
   VALUES (?, ?, ?, ?, ?) RETURNING id, body, author, author_name, created_at`
);
const listNotes = db.query(
  `SELECT id, body, author, author_name, created_at FROM inspection_notes
   WHERE checklist_id = ? AND deleted_at IS NULL ORDER BY id`
);
const countNotes = db.query(
  `SELECT checklist_id, COUNT(*) AS n FROM inspection_notes
   WHERE deleted_at IS NULL GROUP BY checklist_id`
);
const readNote = db.query(
  `SELECT id, checklist_id, author, deleted_at FROM inspection_notes WHERE id = ?`
);
const softDeleteNote = db.query(
  `UPDATE inspection_notes SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL`
);

type NoteRow = {
  id: number; body: string; author: string; author_name: string | null; created_at: string;
};

const toNote = (r: NoteRow): Note => ({
  id: r.id,
  body: r.body,
  author: r.author,
  authorName: r.author_name,
  createdAt: r.created_at,
  deletedAt: null,
});

export function inspectionNotes(checklistId: string): Note[] {
  return (listNotes.all(checklistId) as NoteRow[]).map(toNote);
}

/** One count per inspection, for the list — cheaper than a query per row. */
function noteCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of countNotes.all() as { checklist_id: string; n: number }[]) {
    counts.set(row.checklist_id, row.n);
  }
  return counts;
}

/**
 * Adds a comment. Anyone signed in may: the people who walk the properties are
 * the ones who know what happened after the inspection, and every comment
 * carries their name and the time, on the page and in the addendum.
 *
 * The checklist has to exist — a comment filed against a typo'd id would sit
 * in the database attached to nothing.
 */
export function addInspectionNote(
  checklistId: string,
  user: User,
  body: string
): { note: Note } | { error: string; status: number } {
  if (!readInspection(checklistId)) {
    return { error: "That inspection no longer exists — reload the page.", status: 404 };
  }
  const text = String(body ?? "").trim();
  if (!text) return { error: "A comment needs something in it.", status: 400 };
  if (text.length > NOTE_MAX) {
    return { error: `A comment can be at most ${NOTE_MAX} characters.`, status: 400 };
  }

  const row = insertNote.get(
    checklistId,
    text,
    user.username,
    displayName(user),
    new Date().toISOString()
  ) as NoteRow;
  console.log(
    `[${new Date().toISOString()}] inspection ${checklistId.slice(0, 8)} commented on by ` +
      `${user.username} (note ${row.id}, ${text.length} chars)`
  );
  return { note: toNote(row) };
}

/**
 * Removes a comment from the page and from future addenda. Soft, and only the
 * person who wrote it or Dan: a comment that has already gone out on a PDF
 * shouldn't be able to vanish as though it was never written, and the row is
 * the only record that it was.
 */
export function deleteInspectionNote(
  checklistId: string,
  noteId: number,
  user: User
): { ok: true } | { error: string; status: number } {
  const row = readNote.get(noteId) as
    | { id: number; checklist_id: string; author: string; deleted_at: string | null }
    | undefined;
  if (!row || row.checklist_id !== checklistId || row.deleted_at) {
    return { error: "That comment is already gone — reload the page.", status: 404 };
  }
  if (row.author !== user.username && !canEditTenants(user)) {
    return { error: "You can only remove a comment you wrote.", status: 403 };
  }
  softDeleteNote.run(new Date().toISOString(), user.username, noteId);
  console.log(
    `[${new Date().toISOString()}] inspection ${checklistId.slice(0, 8)} note ${noteId} removed by ${user.username}`
  );
  return { ok: true };
}

/* ------------------------------------------------------------------ counting */

type Tally = {
  rooms: number; items: number; rated: number; blank: number;
  poor: number; fair: number; photos: number; videos: number;
};

function tally(c: Checklist): Tally {
  const t: Tally = { rooms: c.rooms.length, items: 0, rated: 0, blank: 0, poor: 0, fair: 0, photos: 0, videos: 0 };
  for (const room of c.rooms) {
    for (const item of room.items ?? []) {
      t.items++;
      if (!item.condition) t.blank++;
      else t.rated++;
      if (item.condition === "Poor") t.poor++;
      if (item.condition === "Fair") t.fair++;
    }
  }
  for (const a of c.attachments ?? []) {
    if (a.kind === "video") t.videos++;
    else t.photos++;
  }
  return t;
}

/**
 * What somebody wrote down, and what they found wrong. Both are the substance
 * of a walkthrough — a report with nothing here is a report where everything
 * was fine — so the list prints them rather than only counting them.
 *
 * A defect is anything rated Poor or Fair. Its own note travels with it, so it
 * isn't repeated in the notes below; what's left there is everything else that
 * was written: a note against an item nobody faulted, a room's own note, and
 * the general notes about the property.
 */
type Defect = { room: string; label: string; condition: string; notes: string };
type Written = { where: string; what: string; kind: "item" | "room" | "general" };

function defects(c: Checklist): Defect[] {
  const found: Defect[] = [];
  for (const room of c.rooms) {
    for (const item of room.items ?? []) {
      if (item.condition === "Poor" || item.condition === "Fair") {
        found.push({ room: room.name, label: item.label, condition: item.condition, notes: item.notes });
      }
    }
  }
  // Poor first: on a list of twenty reports, that's what a reader is scanning for.
  return found.sort((a, b) => (a.condition === b.condition ? 0 : a.condition === "Poor" ? -1 : 1));
}

function written(c: Checklist): Written[] {
  const notes: Written[] = [];
  for (const room of c.rooms) {
    if (room.notes?.trim()) notes.push({ where: room.name, what: room.notes, kind: "room" });
    for (const item of room.items ?? []) {
      // A Poor or Fair item has already said this alongside its rating.
      if (!item.notes?.trim() || item.condition === "Poor" || item.condition === "Fair") continue;
      notes.push({ where: `${room.name} — ${item.label}`, what: item.notes, kind: "item" });
    }
  }
  if (c.generalNotes?.trim()) {
    notes.push({ where: "Whole property", what: c.generalNotes, kind: "general" });
  }
  return notes;
}

/** Every item marked Poor, with the room it's in — the reason to open a report. */
function poorItems(c: Checklist): { room: string; item: Item }[] {
  const found: { room: string; item: Item }[] = [];
  for (const room of c.rooms) {
    for (const item of room.items ?? []) {
      if (item.condition === "Poor") found.push({ room: room.name, item });
    }
  }
  return found;
}

/* ----------------------------------------------------------------- rendering */

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: unknown): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE, year: "numeric", month: "short", day: "numeric",
});
const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit",
});

/** The stored timestamps are UTC; nobody here thinks in UTC. */
function signedDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : DATE_FORMAT.format(at);
}
function signedTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : TIME_FORMAT.format(at);
}

/** A sortable key for the date column, so sorting doesn't parse the label. */
const conditionClass = (condition: string) =>
  condition === "N/A" ? "na" : condition.toLowerCase().replace(/[^a-z]/g, "");

function conditionPill(condition: string): string {
  if (!condition) return `<span class="cond blank" title="Left blank">&mdash;</span>`;
  return `<span class="cond ${conditionClass(condition)}">${escapeHtml(condition)}</span>`;
}

/** Photos and videos are on disk under the id and the type the server decided. */
const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
};

function attachmentUrl(a: Attachment): string | null {
  const ext = EXTENSIONS[String(a.mime ?? "").split(";")[0].trim().toLowerCase()];
  if (!ext || !/^[0-9a-f-]{36}$/.test(a.id)) return null;
  return `/inspections/uploads/${a.id}.${ext}`;
}

const PAGE_CSS = `
    :root { --ink: #1a1a1a; --muted: #6b7280; --line: #e5e7eb; --accent: #2563eb; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f7f8fa; color: var(--ink);
      font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .page { max-width: 1180px; margin: 0 auto; padding: 0 1.5rem 4rem; }
    .page > h1 { font-size: 1.9rem; letter-spacing: -0.02em; margin: 0 0 0.35rem; }
    .lede { margin: 0 0 1.5rem; color: var(--muted); font-size: 0.9rem; }
    a { color: var(--accent); }
    .notice { margin: 0 0 1rem; padding: 0.6rem 0.85rem; background: #fff8e1; border: 1px solid #f0d68a;
      border-left-width: 3px; border-radius: 6px; font-size: 0.85rem; color: #6b5300; line-height: 1.5; }
    .notice code { background: rgba(0,0,0,0.05); padding: 0 0.2rem; border-radius: 3px; }

    /* Condition, in the same five words the form and the PDF use. Poor is the
       one that has to catch the eye from across the table. */
    .cond { display: inline-block; padding: 0.1rem 0.45rem; border-radius: 4px; font-size: 0.78rem;
      font-weight: 600; white-space: nowrap; }
    .cond.excellent { background: #dcfce7; color: #166534; }
    .cond.good { background: #e3f6e5; color: #1e7d32; }
    .cond.fair { background: #fff4e0; color: #a15c00; }
    .cond.poor { background: #fee2e2; color: #991b1b; }
    .cond.na { background: #f0f0f0; color: #666; }
    .cond.blank { background: #f0f0f0; color: #9ca3af; font-weight: 500; }

    .pdf-link { display: inline-flex; align-items: center; gap: 0.35rem; background: #1f2937; color: #fff;
      border-radius: 6px; padding: 0.3rem 0.65rem; font: 600 0.78rem system-ui, sans-serif;
      text-decoration: none; white-space: nowrap; }
    .pdf-link:hover { background: #374151; }`;

const LIST_CSS = `
    .toolbar { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; margin: 0 0 0.9rem; }
    .toolbar input { flex: 1 1 16rem; max-width: 26rem; padding: 0.45rem 0.7rem; border: 1px solid #d1d5db;
      border-radius: 6px; font: inherit; font-size: 0.88rem; background: #fff; }
    .toolbar input:focus { outline: 2px solid #93c5fd; outline-offset: -1px; border-color: transparent; }
    .toolbar .count { color: var(--muted); font-size: 0.82rem; }
    .toolbar button { background: #fff; border: 1px solid #d1d5db; border-radius: 6px;
      padding: 0.42rem 0.75rem; font: 600 0.8rem system-ui, sans-serif; color: #374151; cursor: pointer; }
    .toolbar button:hover { background: #f3f4f6; }

    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; background: #fff; font-size: 0.9rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { text-align: left; padding: 0.6rem 0.8rem; border-bottom: 1px solid #eee; vertical-align: top; }
    th { background: #f2f2f2; font-weight: 600; font-size: 0.82rem; white-space: nowrap; }
    tbody tr:hover { background: #f9f9f9; }
    td.when { white-space: nowrap; }
    td.when .time { display: block; color: var(--muted); font-size: 0.78rem; }
    /* The identifying columns are deliberately narrow. The width belongs to
       what the walkthrough found, which is the column people are here to read. */
    td.address { min-width: 11rem; width: 14%; }
    td.address a { font-weight: 600; text-decoration: none; }
    td.address a:hover { text-decoration: underline; }
    td.address .sub { display: block; color: var(--muted); font-size: 0.78rem; font-weight: 400; }
    td.who { min-width: 10rem; width: 13%; }
    td.who .sub { display: block; color: var(--muted); font-size: 0.78rem; overflow-wrap: anywhere; }
    td.flags { width: 9rem; }
    td.actions { text-align: right; white-space: nowrap; }
    .flag { display: inline-block; padding: 0.05rem 0.4rem; border-radius: 999px; font-size: 0.75rem;
      font-weight: 600; margin: 0 0.25rem 0.2rem 0; white-space: nowrap; }
    .flag.poor { background: #fee2e2; color: #991b1b; }
    .flag.blank { background: #f3f4f6; color: #6b7280; }
    .flag.media { background: #eef2fb; color: #2b4a9b; }
    .flag.clean { background: #e3f6e5; color: #1e7d32; }
    .flag.note { background: #fef3c7; color: #92400e; }
    .empty td { color: var(--muted); text-align: center; padding: 2rem 0.8rem; }

    /* What was found wrong and what was written down, in the row itself: the
       point of the page is reading these without opening twenty reports. Long
       ones are clamped rather than allowed to push a row off the screen. */
    td.found { width: 48%; min-width: 22rem; }
    .found .list { margin: 0; padding: 0; list-style: none; }
    .found .list.clamped { max-height: 7.4rem; overflow: hidden;
      -webkit-mask-image: linear-gradient(#000 62%, transparent);
      mask-image: linear-gradient(#000 62%, transparent); }
    /* Each finding reads as a line of prose — label, then what was written —
       so a wrapped line starts at the left edge instead of stepping in under
       a hanging indent. It also fits more of the report above the clamp. */
    .found li { padding: 0.2rem 0; font-size: 0.85rem; line-height: 1.45; }
    .found li + li { border-top: 1px solid #f1f2f4; }
    .found .cond { margin-right: 0.3rem; }
    .found .where { font-weight: 600; color: #374151; margin-right: 0.35rem; }
    .found .where.general { color: #92400e; }
    .found .what { color: #4b5563; white-space: pre-wrap; }
    /* A note against an item nobody faulted reads quieter than a defect. */
    .found li.plain .where { font-weight: 500; color: #4b5563; }
    .found li.plain .what { color: #6b7280; }
    .found .none { color: var(--muted); font-size: 0.85rem; }
    .more { margin-top: 0.35rem; padding: 0; background: none; border: 0; cursor: pointer;
      font: 600 0.78rem system-ui, sans-serif; color: var(--accent); }
    .more:hover { text-decoration: underline; }

    /* Stacked cards on a phone — the same treatment the access table gets. The
       findings stay in the card; they are why the row is worth reading. */
    @media (max-width: 860px) {
      .page { padding: 0 0.75rem 2.5rem; }
      .page > h1 { font-size: 1.35rem; }
      table, thead, tbody, th, td, tr { display: block; }
      thead { display: none; }
      table { box-shadow: none; background: transparent; }
      tbody tr { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        margin-bottom: 0.75rem; padding: 0.5rem 0.8rem; }
      td { display: flex; justify-content: space-between; align-items: baseline; gap: 0.75rem;
        padding: 0.45rem 0; border-bottom: 1px solid #f0f0f0; text-align: right; }
      td:last-child { border-bottom: none; }
      td::before { content: attr(data-label); font-weight: 600; color: #666; text-align: left;
        flex: 0 0 auto; }
      /* A cell holding more than one line — the address with its sub-lines, the
         findings, the pills — is stacked under its label rather than laid out
         across the card, which would squeeze each part into a column of its own. */
      td.address, td.who, td.flags, td.found {
        display: block; text-align: left; width: auto; min-width: 0; }
      td.address::before, td.who::before, td.flags::before, td.found::before {
        display: block; margin-bottom: 0.25rem; }
      td.address a { font-size: 1rem; }
      td.address .sub, td.who .sub { display: inline; }
      td.address .sub::before, td.who .sub::before { content: "· "; color: var(--muted); }
      .found li { display: block; }
    }`;

const DETAIL_CSS = `
    .back { display: inline-block; margin: 0 0 0.75rem; font-size: 0.85rem; text-decoration: none; }
    .head { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-start;
      justify-content: space-between; margin-bottom: 1.25rem; }
    .head h1 { margin: 0 0 0.3rem; font-size: 1.6rem; letter-spacing: -0.02em; }
    .head .sub { color: var(--muted); font-size: 0.88rem; margin: 0; }
    .pdf-links { display: flex; flex-direction: column; align-items: flex-end; gap: 0.3rem; }
    .pdf-links .plain { font-size: 0.75rem; color: var(--muted); }

    .facts { display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0 0 1.5rem; }
    .fact { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 0.5rem 0.8rem;
      min-width: 6.5rem; }
    .fact .k { display: block; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.07em;
      color: var(--muted); font-weight: 600; }
    .fact .v { font-size: 1.05rem; font-weight: 600; }
    .fact.poor .v { color: #991b1b; }

    .card { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 0.9rem 1.1rem;
      margin: 0 0 1rem; }
    .card > h2 { font-size: 1rem; margin: 0 0 0.6rem; letter-spacing: -0.01em; }
    .card .room-note { margin: -0.35rem 0 0.6rem; color: var(--muted); font-size: 0.85rem; }
    .card table { border-collapse: collapse; width: 100%; font-size: 0.88rem; }
    .card th, .card td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #f1f2f4;
      vertical-align: top; }
    .card th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
    .card tr:last-child td { border-bottom: 0; }
    .card td.label { width: 32%; }
    .card td.state { width: 6.5rem; }
    .card td.notes { color: #374151; }
    .card tr.is-poor td { background: #fff5f5; }
    .card tr.is-poor td.label { font-weight: 600; color: #991b1b; }

    h2.band { font-size: 1.1rem; margin: 2rem 0 0.9rem; letter-spacing: -0.01em; }
    .prose { white-space: pre-wrap; font-size: 0.92rem; margin: 0; }
    .flagged { border-left: 3px solid #dc2626; }
    .flagged li { margin-bottom: 0.35rem; }
    .flagged .where { font-weight: 600; }

    .media { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.6rem; }
    .media a, .media video { display: block; width: 100%; border-radius: 8px; border: 1px solid var(--line);
      background: #fff; overflow: hidden; }
    .media img { display: block; width: 100%; height: 150px; object-fit: cover; }
    .media .missing { display: flex; align-items: center; justify-content: center; height: 150px;
      color: var(--muted); font-size: 0.8rem; text-align: center; padding: 0.5rem; }

    .sigs { display: flex; flex-wrap: wrap; gap: 1rem; }
    .sig { flex: 1 1 15rem; }
    .sig img { display: block; max-width: 100%; height: 70px; object-fit: contain; object-position: left bottom;
      border-bottom: 1px solid #cbd5e1; padding-bottom: 0.2rem; }
    .sig .unsigned { height: 70px; display: flex; align-items: flex-end; color: var(--muted);
      font-size: 0.82rem; border-bottom: 1px solid #cbd5e1; padding-bottom: 0.2rem; }
    .sig .who { margin: 0.3rem 0 0; font-size: 0.85rem; font-weight: 600; }
    .sig .role { margin: 0; color: var(--muted); font-size: 0.78rem; }
    .terms { color: #374151; font-size: 0.85rem; }
    .terms li { margin-bottom: 0.3rem; }

    /* Comments added after signing. Kept visibly apart from everything above
       them, because nothing here was certified by anybody. */
    .comments { border-left: 3px solid #a16207; }
    .comments .why { margin: -0.35rem 0 0.9rem; color: var(--muted); font-size: 0.82rem; }
    .note { border-top: 1px solid #f1f2f4; padding: 0.7rem 0; }
    .note:first-of-type { border-top: 0; padding-top: 0.2rem; }
    .note .meta { display: flex; align-items: baseline; gap: 0.5rem; margin: 0 0 0.25rem; }
    .note .author { font-weight: 600; font-size: 0.88rem; }
    .note .at { color: var(--muted); font-size: 0.78rem; }
    .note .body { margin: 0; white-space: pre-wrap; font-size: 0.92rem; color: #374151; }
    .note .drop { margin-left: auto; background: none; border: 0; padding: 0; cursor: pointer;
      color: var(--muted); font: inherit; font-size: 0.78rem; text-decoration: underline; }
    .note .drop:hover { color: #991b1b; }
    .note .drop[disabled] { opacity: 0.5; cursor: default; }
    .no-notes { color: var(--muted); font-size: 0.88rem; margin: 0 0 0.2rem; }

    .add-note { margin-top: 0.9rem; border-top: 1px solid #f1f2f4; padding-top: 0.8rem; }
    .add-note textarea { width: 100%; min-height: 5rem; padding: 0.5rem 0.65rem; border: 1px solid #d1d5db;
      border-radius: 6px; font: inherit; font-size: 0.9rem; resize: vertical; background: #fff; }
    .add-note textarea:focus { outline: 2px solid #93c5fd; outline-offset: -1px; border-color: transparent; }
    .add-note .row { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.5rem; }
    .add-note button { background: #1f2937; color: #fff; border: 0; border-radius: 6px;
      padding: 0.42rem 0.85rem; font: 600 0.82rem system-ui, sans-serif; cursor: pointer; }
    .add-note button:hover { background: #374151; }
    .add-note button[disabled] { opacity: 0.6; cursor: default; }
    .add-note .hint { color: var(--muted); font-size: 0.78rem; }
    .add-note .err { color: #991b1b; font-size: 0.8rem; }

    @media (max-width: 720px) {
      .page { padding: 0 0.75rem 2.5rem; }
      .head h1 { font-size: 1.3rem; }
      .card td.label, .card td.state { width: auto; }
    }`;

/** Filtering only — the list is small and already in the order people want. */
/**
 * Filtering, and the clamp on a long findings column. Both touch the same
 * rows, and both are about the same thing: getting to the report somebody is
 * after without making them open anything.
 */
const LIST_JS = `
(function () {
  var box = document.getElementById("inspection-search");
  var table = document.getElementById("inspections");
  var count = document.getElementById("shown-count");
  var all = document.getElementById("expand-all");
  if (!table) return;
  var rows = [].slice.call(table.querySelectorAll("tbody tr[data-search]"));
  var empty = table.querySelector("tr.no-match");

  function setOpen(tr, open) {
    var list = tr.querySelector(".found .list");
    var button = tr.querySelector("button.more");
    if (!list || !button) return; // short enough to have never been clamped
    list.classList.toggle("clamped", !open);
    button.setAttribute("aria-expanded", open ? "true" : "false");
    button.textContent = open ? "Show less" : "Show all " + list.children.length;
  }
  function isOpen(tr) {
    var button = tr.querySelector("button.more");
    return !!button && button.getAttribute("aria-expanded") === "true";
  }
  function syncAllLabel() {
    if (!all) return;
    var openable = rows.filter(function (tr) { return !tr.hidden && tr.querySelector("button.more"); });
    var anyClosed = openable.some(function (tr) { return !isOpen(tr); });
    all.textContent = anyClosed ? "Show all findings" : "Clamp long ones";
    all.dataset.act = anyClosed ? "open" : "close";
    all.hidden = openable.length === 0;
  }

  table.addEventListener("click", function (e) {
    var button = e.target.closest("button.more");
    if (!button) return;
    var tr = button.closest("tr");
    setOpen(tr, !isOpen(tr));
    syncAllLabel();
  });

  if (all) {
    all.addEventListener("click", function () {
      var open = all.dataset.act === "open";
      rows.forEach(function (tr) { if (!tr.hidden) setOpen(tr, open); });
      syncAllLabel();
    });
  }

  if (box) {
    box.addEventListener("input", function () {
      var q = box.value.trim().toLowerCase();
      var shown = 0;
      rows.forEach(function (tr) {
        var hit = !q || tr.dataset.search.indexOf(q) !== -1;
        tr.hidden = !hit;
        // Filtering to a handful shows all of what they say — the match is
        // often in a line the clamp is sitting on. Clearing the box clamps
        // them again, so the page goes back to being scannable.
        setOpen(tr, hit && !!q);
        if (hit) shown++;
      });
      if (empty) empty.hidden = shown !== 0;
      if (count) count.textContent = shown === rows.length
        ? rows.length + (rows.length === 1 ? " inspection" : " inspections")
        : shown + " of " + rows.length;
      syncAllLabel();
    });
  }

  syncAllLabel();
})();`;

/**
 * One comment. Rendered here on first load and again when one is posted, so a
 * new comment comes back formatted by the same code rather than by a second
 * copy of these rules in the browser — the same bargain as a tenant row.
 */
export function renderNote(note: Note, user: User): string {
  const mine = note.author === user.username || canEditTenants(user);
  return `
      <article class="note" data-note="${note.id}">
        <p class="meta"><span class="author">${escapeHtml(note.authorName || note.author)}</span>
          <span class="at">${escapeHtml(signedDate(note.createdAt))} at ${escapeHtml(signedTime(note.createdAt))}</span>
          ${mine ? `<button type="button" class="drop" data-act="delete-note">Remove</button>` : ""}</p>
        <p class="body">${escapeHtml(note.body)}</p>
      </article>`;
}

/**
 * Posting and removing comments. Kept small: the page reloads nothing, because
 * losing a half-typed comment to a reload is the whole reason people write them
 * somewhere else instead.
 */
const NOTES_JS = `
(function () {
  var card = document.getElementById("comments");
  if (!card) return;
  var id = card.dataset.inspection;
  var list = document.getElementById("note-list");
  var empty = document.getElementById("no-notes");
  var box = document.getElementById("note-body");
  var button = document.getElementById("add-note");
  var error = document.getElementById("note-error");
  var count = document.getElementById("note-count");

  function note(message) {
    error.textContent = message || "";
    error.hidden = !message;
  }
  function retally() {
    var n = list.querySelectorAll(".note").length;
    if (empty) empty.hidden = n !== 0;
    if (count) count.textContent = n === 0 ? "" : n + (n === 1 ? " comment" : " comments");
  }

  function post() {
    var body = box.value.trim();
    if (!body) { box.focus(); return; }
    button.disabled = true;
    note("");
    fetch("/api/inspections/" + id + "/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: body })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "Comment not saved.");
          return data;
        });
      })
      .then(function (data) {
        // Only cleared once the server has it — a failed post keeps the typing.
        box.value = "";
        list.insertAdjacentHTML("beforeend", data.note);
        retally();
      })
      .catch(function (err) { note(err.message); })
      .then(function () { button.disabled = false; });
  }

  button.addEventListener("click", post);
  // Ctrl/Cmd+Enter posts; a bare Enter is a new paragraph, since these run long.
  box.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post(); }
  });

  list.addEventListener("click", function (e) {
    var drop = e.target.closest('button[data-act="delete-note"]');
    if (!drop) return;
    var article = drop.closest(".note");
    if (!window.confirm("Remove this comment? It stops printing on the addendum.")) return;
    drop.disabled = true;
    note("");
    fetch("/api/inspections/" + id + "/notes/" + article.dataset.note, { method: "DELETE" })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "Comment not removed.");
        });
      })
      .then(function () { article.remove(); retally(); })
      .catch(function (err) { drop.disabled = false; note(err.message); });
  });
})();`;

function page(title: string, nav: string, navCss: string, css: string, body: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  ${FAVICON_LINK}
  <style>
${navCss}
${PAGE_CSS}
${css}
  </style>
</head>
<body>
  ${nav}
  <div class="page">
${body}
  </div>
</body>
</html>`;
}

const UNREADABLE = `<p class="notice"><strong>The checklist database can't be read right now.</strong>
    The inspections live in <code>${escapeHtml(CHECKLIST_DB)}</code>, written by the checklist app on
    :3100. Check that the file is there and that this app can read it.</p>`;

/**
 * One row. Everything that identifies the inspection is squeezed left so the
 * findings column can have the width: a reader is here to see what the
 * walkthrough turned up, not to admire six columns of counts.
 */
function listRow(i: Inspection, notes: number): string {
  const c = i.checklist;
  const t = tally(c);
  const found = defects(c);
  const wrote = written(c);

  const flags =
    (t.poor ? `<span class="flag poor">${t.poor} poor</span>` : "") +
    (t.blank ? `<span class="flag blank">${t.blank} blank</span>` : "") +
    (!t.poor && !t.blank ? `<span class="flag clean">all rated</span>` : "") +
    (t.photos ? `<span class="flag media">${t.photos} photo${t.photos === 1 ? "" : "s"}</span>` : "") +
    (t.videos ? `<span class="flag media">${t.videos} video${t.videos === 1 ? "" : "s"}</span>` : "") +
    // A commented report reads differently from the one that was signed, so the
    // list says so before anyone sends the PDF on.
    (notes ? `<span class="flag note">${notes} comment${notes === 1 ? "" : "s"}</span>` : "");

  // Defects first, with their notes, then everything else that was written.
  const entries = [
    ...found.map(
      (d) => `<li>${conditionPill(d.condition)}
                <span class="where">${escapeHtml(d.room)} &mdash; ${escapeHtml(d.label)}</span>${
                  d.notes ? `<span class="what">${escapeHtml(d.notes)}</span>` : ""
                }</li>`
    ),
    ...wrote.map(
      (w) => `<li class="plain"><span class="where${
        w.kind === "general" ? " general" : ""
      }">${escapeHtml(w.where)}</span><span class="what">${escapeHtml(w.what)}</span></li>`
    ),
  ];

  // Six lines of one report is about what a reader can take in while scanning
  // twenty of them; a walkthrough that found twenty-five things says so and
  // opens in place. The clamp is CSS, so nothing is hidden from Ctrl+F.
  const CLAMP_AT = 4;
  const clamped = entries.length > CLAMP_AT;
  const findings = entries.length
    ? `<ul class="list${clamped ? " clamped" : ""}">${entries.join("")}</ul>${
        clamped
          ? `<button type="button" class="more" aria-expanded="false">Show all ${entries.length}</button>`
          : ""
      }`
    : `<span class="none">Nothing flagged, nothing written.</span>`;

  // Everything the search box matches on, lower-cased once here rather than on
  // every keystroke in the browser. The findings are in here too: "dishwasher"
  // or "smoke detector" is how somebody looks for the report they half
  // remember, and a clamped line is still the report's text.
  const haystack = [
    c.address,
    c.name,
    c.email,
    c.agentName ?? "",
    signedDate(i.createdAt),
    ...found.map((d) => `${d.room} ${d.label} ${d.condition} ${d.notes}`),
    ...wrote.map((w) => `${w.where} ${w.what}`),
  ]
    .join(" ")
    .toLowerCase();

  return `
        <tr data-search="${escapeAttr(haystack)}" data-id="${escapeAttr(i.id)}">
          <td class="when" data-label="Signed">${escapeHtml(signedDate(i.createdAt))}
            <span class="time">${escapeHtml(signedTime(i.createdAt))}</span></td>
          <td class="address" data-label="Property"><a href="/inspections/${escapeAttr(i.id)}">${escapeHtml(c.address)}</a>
            <span class="sub">${c.bedrooms} bd &middot; ${c.bathrooms} ba</span>
            <span class="sub">${t.rooms} rooms &middot; ${t.items} items</span></td>
          <td class="who" data-label="Tenant">${escapeHtml(c.name)}
            <span class="sub">${escapeHtml(c.email)}</span>
            <span class="sub">Agent: ${escapeHtml(c.agentName || "none")}</span></td>
          <td class="flags" data-label="Flags">${flags}</td>
          <td class="found" data-label="Defects &amp; notes">${findings}</td>
          <td class="actions" data-label="Report">
            <a class="pdf-link" href="/inspections/${escapeAttr(i.id)}.pdf" target="_blank" rel="noopener">PDF</a></td>
        </tr>`;
}

export function renderInspectionsList(nav: string, navCss: string): string {
  const inspections = listInspections();
  if (inspections === null) {
    return page("Inspections", nav, navCss, LIST_CSS, `  <h1>Inspections</h1>\n  ${UNREADABLE}`);
  }

  const withPoor = inspections.filter((i) => tally(i.checklist).poor > 0).length;
  const counts = noteCounts();
  const body = `  <h1>Inspections</h1>
  <p class="lede">Every signed move-in condition report, newest first &mdash;
    ${inspections.length} in all${withPoor ? `, ${withPoor} with something marked poor` : ""}.
    What each walkthrough found is in the row itself; open a report to read it room by room,
    or take the PDF the tenant signed.</p>

  <div class="toolbar">
    <input type="search" id="inspection-search"
      placeholder="Filter by property, tenant, agent, date &mdash; or anything written in a note"
      autocomplete="off" aria-label="Filter inspections" />
    <button type="button" id="expand-all" data-act="open">Show all findings</button>
    <span class="count" id="shown-count">${inspections.length} ${
      inspections.length === 1 ? "inspection" : "inspections"
    }</span>
  </div>

  <div class="table-wrap">
    <table id="inspections">
      <thead>
        <tr>
          <th>Signed</th><th>Property</th><th>Tenant</th><th>Flags</th>
          <th>Defects &amp; notes</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${
          inspections.length
            ? inspections.map((i) => listRow(i, counts.get(i.id) ?? 0)).join("") +
              `\n        <tr class="empty no-match" hidden><td colspan="6">No inspection matches that.</td></tr>`
            : `<tr class="empty"><td colspan="6">No inspections have been signed yet.</td></tr>`
        }
      </tbody>
    </table>
  </div>
  <script>${LIST_JS}</script>`;
  return page("Inspections", nav, navCss, LIST_CSS, body);
}

function roomCard(room: Room): string {
  const rows = (room.items ?? [])
    .map(
      (item) => `
          <tr${item.condition === "Poor" ? ' class="is-poor"' : ""}>
            <td class="label">${escapeHtml(item.label)}</td>
            <td class="state">${conditionPill(item.condition)}</td>
            <td class="notes">${escapeHtml(item.notes)}</td>
          </tr>`
    )
    .join("");

  return `
  <section class="card">
    <h2>${escapeHtml(room.name)}</h2>
    ${room.notes ? `<p class="room-note">${escapeHtml(room.notes)}</p>` : ""}
    <table>
      <thead><tr><th>Item</th><th>Condition</th><th>Notes</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="3" class="notes">Nothing was recorded for this room.</td></tr>`}</tbody>
    </table>
  </section>`;
}

function mediaTile(a: Attachment): string {
  const url = attachmentUrl(a);
  const label = escapeAttr(`${a.name || a.kind} — ${Math.round((a.size ?? 0) / 1024)}KB`);
  if (!url) {
    return `<div class="missing" title="${label}">${escapeHtml(a.name || a.kind)} (not stored)</div>`;
  }
  if (a.kind === "video") {
    return `<video controls preload="metadata" src="${escapeAttr(url)}" title="${label}"></video>`;
  }
  return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener" title="${label}">
        <img src="${escapeAttr(url)}" alt="${escapeAttr(a.name || "Inspection photo")}" loading="lazy" /></a>`;
}

/**
 * A signature block. The signature images are the tenant's and the agent's own
 * marks, kept as the checklist app stored them; an agent named but not signed
 * prints a line, exactly as the PDF does.
 */
function signatureBlock(png: string | undefined, who: string, role: string, when: string): string {
  const mark =
    png && png.startsWith("data:image/")
      ? `<img src="${escapeAttr(png)}" alt="${escapeAttr(who + " signature")}" />`
      : `<div class="unsigned">Not signed electronically</div>`;
  return `<div class="sig">${mark}
      <p class="who">${escapeHtml(who)}</p>
      <p class="role">${escapeHtml(role)}${when ? ` &middot; ${escapeHtml(when)}` : ""}</p>
    </div>`;
}

export function renderInspection(id: string, user: User, nav: string, navCss: string): string | null {
  const inspection = readInspection(id);
  if (!inspection) return null;
  const c = inspection.checklist;
  const t = tally(c);
  const poor = poorItems(c);
  const notes = inspectionNotes(inspection.id);
  const when = `${signedDate(inspection.createdAt)} at ${signedTime(inspection.createdAt)}`;

  const facts = [
    { k: "Rooms", v: String(t.rooms) },
    { k: "Items rated", v: `${t.rated}/${t.items}` },
    { k: "Poor", v: String(t.poor), poor: t.poor > 0 },
    { k: "Left blank", v: String(t.blank) },
    { k: "Photos", v: String(t.photos) },
    { k: "Videos", v: String(t.videos) },
  ]
    .map(
      (f) => `<div class="fact${f.poor ? " poor" : ""}"><span class="k">${escapeHtml(f.k)}</span>
      <span class="v">${escapeHtml(f.v)}</span></div>`
    )
    .join("");

  const body = `  <a class="back" href="/inspections">&larr; All inspections</a>
  <div class="head">
    <div>
      <h1>${escapeHtml(c.address)}</h1>
      <p class="sub">${escapeHtml(c.name)} &middot; ${escapeHtml(c.email)} &middot; signed ${escapeHtml(when)}
        ${c.agentName ? `&middot; agent ${escapeHtml(c.agentName)}` : "&middot; no agent present"}</p>
    </div>
    <div class="pdf-links">
      <a class="pdf-link" href="/inspections/${escapeAttr(inspection.id)}.pdf" target="_blank" rel="noopener">
        ${notes.length ? "PDF with comments" : "Signed PDF"}</a>
      ${
        notes.length
          ? `<a class="plain" href="/inspections/${escapeAttr(inspection.id)}.pdf?original=1"
        target="_blank" rel="noopener">As signed, without the addendum</a>`
          : ""
      }
    </div>
  </div>

  <div class="facts">${facts}</div>

  ${
    poor.length
      ? `<section class="card flagged">
    <h2>Marked poor</h2>
    <ul>${poor
      .map(
        (p) =>
          `<li><span class="where">${escapeHtml(p.room)} &mdash; ${escapeHtml(p.item.label)}</span>${
            p.item.notes ? `: ${escapeHtml(p.item.notes)}` : ""
          }</li>`
      )
      .join("")}</ul>
  </section>`
      : ""
  }

  <h2 class="band">Room by room</h2>
  ${c.rooms.map(roomCard).join("")}

  ${
    c.generalNotes
      ? `<section class="card"><h2>General notes</h2><p class="prose">${escapeHtml(c.generalNotes)}</p></section>`
      : ""
  }

  ${
    (c.attachments ?? []).length
      ? `<h2 class="band">Photos and videos</h2>
  <div class="media">${c.attachments.map(mediaTile).join("")}</div>`
      : ""
  }

  <h2 class="band">Signatures</h2>
  <section class="card">
    <div class="sigs">
      ${signatureBlock(c.signature, c.name, "Tenant", when)}
      ${
        c.agentName
          ? signatureBlock(c.agentSignature, c.agentName, "Agent / landlord representative", when)
          : `<div class="sig"><div class="unsigned">No agent present at inspection</div>
        <p class="who">&mdash;</p><p class="role">Agent / landlord representative</p></div>`
      }
    </div>
  </section>

  <h2 class="band">Comments added after signing</h2>
  <section class="card comments" id="comments" data-inspection="${escapeAttr(inspection.id)}">
    <p class="why">Nobody has signed these and they aren&rsquo;t part of what was certified above &mdash;
      they print as an addendum <strong>after</strong> the signed pages of the PDF, each with who wrote it
      and when. The signed pages themselves never change.
      <span id="note-count">${
        notes.length ? `${notes.length} comment${notes.length === 1 ? "" : "s"}` : ""
      }</span></p>
    <div id="note-list">${notes.map((n) => renderNote(n, user)).join("")}</div>
    <p class="no-notes" id="no-notes"${notes.length ? " hidden" : ""}>No comments yet.</p>
    <div class="add-note">
      <textarea id="note-body" maxlength="${NOTE_MAX}"
        placeholder="A repair booked, something the tenant raised later, context worth having next year&hellip;"
        aria-label="Add a comment"></textarea>
      <div class="row">
        <button type="button" id="add-note">Add comment</button>
        <span class="hint">Posted as ${escapeHtml(displayName(user))} &middot; &#8984;/Ctrl + Enter</span>
        <span class="err" id="note-error" hidden></span>
      </div>
    </div>
  </section>
  <script>${NOTES_JS}</script>

  <section class="card">
    <h2>What was certified</h2>
    <p class="prose terms">${escapeHtml(c.certification)}</p>
    ${
      (c.acknowledgements ?? []).length
        ? `<ul class="terms">${c.acknowledgements.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`
        : ""
    }
  </section>`;

  return page(`${c.address} — inspection`, nav, navCss, DETAIL_CSS, body);
}

/* ------------------------------------------------------------------- serving */

const NO_STORE = { "Cache-Control": "no-store, private" } as const;

/** The signed bytes, off the disk or rebuilt by the checklist app. */
async function signedPdfBytes(inspection: Inspection, name: string): Promise<Uint8Array | null> {
  if (inspection.pdfFile === name) {
    const stored = Bun.file(`${PDF_DIR}/${name}`);
    if (await stored.exists()) return new Uint8Array(await stored.arrayBuffer());
  }
  // The file has gone missing. The checklist app rebuilds one from the stored
  // answers on request, which beats reporting a gap — the whole point of that
  // directory is that the record survives.
  try {
    const rebuilt = await fetch(`${CHECKLIST_URL}/checklists/${inspection.id}.pdf`);
    if (rebuilt.ok) {
      console.log(
        `[${new Date().toISOString()}] inspection ${inspection.id.slice(0, 8)} PDF rebuilt by the checklist app`
      );
      return new Uint8Array(await rebuilt.arrayBuffer());
    }
  } catch (err) {
    console.warn(`Could not reach the checklist app at ${CHECKLIST_URL} for ${inspection.id}.`, err);
  }
  return null;
}

/**
 * The signed copy, with any comments appended as an addendum after the signed
 * pages. `?original=1` serves the file exactly as it was signed, with nothing
 * added — which is the version to hand over if anyone ever has to prove what
 * the two parties actually put their names to.
 */
export async function serveInspectionPdf(id: string, original = false): Promise<Response> {
  const inspection = readInspection(id);
  if (!inspection) return new Response("Not found", { status: 404 });

  // Only a bare file name is ever used as a path, whatever the column holds.
  const file = inspection.pdfFile;
  const name = file && /^[A-Za-z0-9._-]+\.pdf$/.test(file) ? file : `inspection-${id.slice(0, 8)}.pdf`;
  const signed = await signedPdfBytes(inspection, name);
  if (!signed) {
    return new Response(
      "The signed PDF isn't on disk and the checklist app on :3100 couldn't be reached to rebuild it.",
      { status: 404, headers: NO_STORE }
    );
  }

  const notes = original ? [] : inspectionNotes(id);
  let bytes = signed;
  if (notes.length) {
    try {
      const c = inspection.checklist;
      bytes = await appendAddendum(
        signed,
        {
          id: inspection.id,
          address: c.address,
          tenant: c.name,
          signedAt: c.signedAt || inspection.createdAt,
          signedPages: await countPages(signed),
        },
        notes
      );
    } catch (err) {
      // A comment that can't be laid out must not cost anyone the signed
      // document; the page still shows every comment either way.
      console.warn(`Could not append the addendum for ${id}; serving the signed PDF alone.`, err);
      bytes = signed;
    }
  }

  return new Response(bytes, {
    headers: {
      "Content-Type": "application/pdf",
      // Named so a file with comments on it can't be mistaken for the signed
      // copy once it's sitting in somebody's downloads folder.
      "Content-Disposition": `inline; filename="${
        notes.length ? name.replace(/\.pdf$/, "") + "_with-comments.pdf" : name
      }"`,
      ...NO_STORE,
    },
  });
}

/** How many pages the signed document has, for the addendum's own wording. */
async function countPages(pdf: Uint8Array): Promise<number> {
  try {
    return (await PDFDocument.load(pdf)).getPageCount();
  } catch {
    return 0;
  }
}

/** A photo or video attached to a checklist, straight off the checklist app's disk. */
export async function serveInspectionUpload(fileName: string): Promise<Response> {
  // Built only from a uuid and an extension this app matched, never from a name
  // that arrived over the wire.
  if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,5}$/.test(fileName)) return new Response("Not found", { status: 404 });
  const stored = Bun.file(`${UPLOAD_DIR}/${fileName}`);
  if (!(await stored.exists())) return new Response("Not found", { status: 404 });
  return new Response(stored, {
    headers: { "Content-Type": stored.type || "application/octet-stream", ...NO_STORE },
  });
}
