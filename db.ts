import { Database } from "bun:sqlite";

/** Override with DB_PATH to run against a scratch copy instead of the real data. */
export const db = new Database(process.env.DB_PATH ?? "crm.db");

// ON DELETE CASCADE for sessions only works with this on, and it is per-connection.
db.run("PRAGMA foreign_keys = ON");
// WAL lets the user CLI write while the server is reading.
db.run("PRAGMA journal_mode = WAL");

/**
 * Auth tables, created on demand so an existing crm.db picks them up on the
 * next start. Tenant/sheet tables predate this and live in schema.sql.
 */
db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT,
    password_hash TEXT NOT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME
  )`);

db.run(`
  CREATE TABLE IF NOT EXISTS sessions (
    -- SHA-256 of the cookie value, never the value itself: a stolen copy of
    -- this table can't be replayed as a login.
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    user_agent  TEXT
  )`);

db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`);

/**
 * Small pieces of shared app state that aren't tenant data — currently just the
 * Tenants & Access column layout. One row per key, the value a JSON document,
 * so a new setting doesn't mean a new table. `updated_by` records which account
 * last wrote it, since these are settings one person changes for everyone.
 */
db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT
  )`);

/**
 * Usernames allowed to create an account. Signing up is only possible for a
 * name listed here and not yet claimed.
 *
 * `code_hash` is optional. NULL means the person can just sign up with that
 * username; a value means they also need the one-time code from an invite link,
 * which is what stops someone else claiming the name first.
 */
db.run(`
  CREATE TABLE IF NOT EXISTS approved_users (
    username     TEXT PRIMARY KEY COLLATE NOCASE,
    display_name TEXT,
    code_hash    TEXT,
    created_at   INTEGER NOT NULL,
    used_at      INTEGER
  )`);

/**
 * Two pieces of protection for the sheets, added 2026-08-05 after a page that
 * had been open for seventeen hours saved its copy over everyone else's work
 * and took a day of tour entries with it.
 *
 * `sheets.rev` is bumped on every save. A page sends back the rev it loaded
 * with, and server.ts refuses a save whose rev is behind — so a stale page
 * can no longer overwrite newer work; it's told to catch up instead.
 *
 * `sheet_versions` keeps the last few dozen saved states of each sheet, so if
 * something does go wrong the previous content is a query away rather than a
 * forensic dig through the SQLite write-ahead log.
 */
const sheetColumns = db.query(`PRAGMA table_info(sheets)`).all() as { name: string }[];
if (sheetColumns.length && !sheetColumns.some((c) => c.name === "rev")) {
  db.run(`ALTER TABLE sheets ADD COLUMN rev INTEGER NOT NULL DEFAULT 1`);
}

db.run(`
  CREATE TABLE IF NOT EXISTS sheet_versions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id  TEXT NOT NULL,
    rev       INTEGER NOT NULL,
    columns   TEXT NOT NULL,
    rows      TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    saved_by  TEXT,
    saved_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);

db.run(`CREATE INDEX IF NOT EXISTS idx_sheet_versions ON sheet_versions(sheet_id, id DESC)`);

/**
 * Comments added to a signed inspection after the fact — a repair booked, a
 * disagreement noted, context somebody wants on the record next year.
 *
 * They live here rather than in the checklist app's database, which this app
 * only ever reads: a checklist is what the tenant signed, and nothing the
 * office types afterwards belongs inside that record. They print on the PDF as
 * an addendum after the signed pages, never among them (see addendum.ts).
 *
 * `author_name` is the display name as it was when the comment was written, so
 * a renamed account doesn't rewrite what an old addendum says. Deleting is a
 * soft delete: a comment that has already gone out on a PDF shouldn't leave no
 * trace of having existed.
 */
db.run(`
  CREATE TABLE IF NOT EXISTS inspection_notes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    checklist_id TEXT NOT NULL,
    body         TEXT NOT NULL,
    author       TEXT NOT NULL,
    author_name  TEXT,
    created_at   TEXT NOT NULL,
    deleted_at   TEXT,
    deleted_by   TEXT
  )`);

db.run(`CREATE INDEX IF NOT EXISTS idx_inspection_notes ON inspection_notes(checklist_id, id)`);

/**
 * Signatures put to an inspection after it was signed.
 *
 * The agent is often not at the walkthrough, a co-tenant signs the next day, a
 * contractor confirms what they were shown a week later. None of that can go
 * into the checklist itself: `checklists.db` is read-only here, and the PDF in
 * `checklist/pdfs/` is the document the tenant certified — rewriting it to add
 * a name is exactly what a record like this must never do.
 *
 * So a later signature is kept here and prints in the addendum, after the
 * signed pages, saying what it is. It carries a remark of its own, because
 * somebody signing a report a week on usually has something to say about it,
 * and nothing they write changes a word of what was recorded on the day.
 *
 * `added_by` is the account that captured it — often not the signer, who may
 * be a tenant signing on somebody's laptop — and both names are stored as they
 * stood, so a renamed account doesn't rewrite an old addendum. Deleting is
 * soft, for the same reason it is for a comment.
 */
db.run(`
  CREATE TABLE IF NOT EXISTS inspection_signatures (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    checklist_id  TEXT NOT NULL,
    signer_name   TEXT NOT NULL,
    role          TEXT NOT NULL,
    remark        TEXT NOT NULL DEFAULT '',
    -- The PNG the canvas produced, as a data URL, exactly as the checklist app
    -- stores the signatures made on the day.
    signature     TEXT NOT NULL,
    signed_at     TEXT NOT NULL,
    added_by      TEXT NOT NULL,
    added_by_name TEXT,
    deleted_at    TEXT,
    deleted_by    TEXT
  )`);

db.run(`CREATE INDEX IF NOT EXISTS idx_inspection_signatures ON inspection_signatures(checklist_id, id)`);

/**
 * Links handed to somebody outside the office so they can sign an inspection
 * themselves.
 *
 * A tenant, a landlord or a contractor has no account here and never will —
 * making one to collect a signature is a worse idea than the problem it
 * solves. So the office creates a link, sends it, and whoever holds it can read
 * the report and sign it once. The token *is* the authority, exactly as it is
 * for a checklist PDF: unguessable, and treated as the credential it is.
 *
 * Which is why each one is narrow. It signs one inspection and nothing else,
 * it expires, it can be revoked, and it stops working the moment it has been
 * used. It carries who it was made for so a report can say what is outstanding
 * and who was chased.
 */
db.run(`
  CREATE TABLE IF NOT EXISTS inspection_sign_links (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    token           TEXT NOT NULL UNIQUE,
    checklist_id    TEXT NOT NULL,
    signer_name     TEXT NOT NULL DEFAULT '',
    role            TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    created_by      TEXT NOT NULL,
    created_by_name TEXT,
    expires_at      TEXT NOT NULL,
    used_at         TEXT,
    signature_id    INTEGER,
    revoked_at      TEXT,
    revoked_by      TEXT
  )`);

db.run(`CREATE INDEX IF NOT EXISTS idx_inspection_sign_links ON inspection_sign_links(checklist_id, id)`);

// Added when signing moved off this machine; existing databases pick it up here.
if (
  !(db.query(`PRAGMA table_info(inspection_signatures)`).all() as { name: string }[])
    .some((c) => c.name === "link_id")
) {
  db.run(`ALTER TABLE inspection_signatures ADD COLUMN link_id INTEGER`);
}

/** How many past states of each sheet to keep. Roughly a day of active use. */
export const SHEET_VERSIONS_KEPT = 60;

// Carry over rows from the earlier `invites` table, which required a code.
const hasOldInvites = db
  .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'invites'`)
  .get();
if (hasOldInvites) {
  db.run(`
    INSERT OR IGNORE INTO approved_users (username, display_name, code_hash, created_at, used_at)
    SELECT username, display_name, code_hash, created_at, used_at FROM invites`);
  db.run(`DROP TABLE invites`);
}

/**
 * One row per tour that has been picked up for a Google Calendar event.
 *
 * This is a queue rather than a fire-and-forget call for two reasons. A save
 * must never fail because Google is slow or down — the tour row is the record
 * that matters, the invite is a convenience — so posting happens after the
 * save has already committed, and a failure just leaves a row to retry. And
 * `key` being the primary key is what stops a second event: the sheets API
 * saves the whole tours sheet on every edit, so the same tour is seen again on
 * every subsequent save, and `INSERT OR IGNORE` is the whole dedupe.
 *
 * `key` is derived from the tour's identity (prospect, property, date), not
 * from its row position: rows get re-sorted and inserted above one another
 * constantly, and a position-based key would re-invite everybody the first
 * time somebody sorted the sheet.
 */
db.run(`
  CREATE TABLE IF NOT EXISTS tour_events (
    key         TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    starts_at   TEXT NOT NULL,
    payload     TEXT NOT NULL,
    payload_sig TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'pending',
    attempts    INTEGER NOT NULL DEFAULT 0,
    last_error  TEXT,
    event_id    TEXT,
    event_url   TEXT,
    added_by    TEXT,
    created_at  TEXT NOT NULL,
    sent_at     TEXT
  )`);

db.run(`CREATE INDEX IF NOT EXISTS idx_tour_events_state ON tour_events(state, attempts)`);

/**
 * Cars found parked in the driveway that shouldn't be there.
 *
 * The point of the table is the repeat: one neighbour blocking the drive once
 * is an accident, the same plate four times is a pattern worth acting on. So
 * `plate` holds a normalised form — upper case, letters and digits only — and
 * is indexed, because "7ABC123", "7abc-123" and "7 ABC 123" are one car and
 * have to collide. `plate_typed` keeps what the person actually entered, since
 * that is evidence and shouldn't be quietly rewritten.
 *
 * Photos are optional and there are at most two: a plate and a wider shot
 * showing where the car was. They are stored as files, with only the id here.
 *
 * Deleting is soft. A report that has been used to ask somebody to stop
 * parking there shouldn't be able to vanish without trace.
 */
db.run(`
  CREATE TABLE IF NOT EXISTS plate_reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    plate        TEXT NOT NULL,
    plate_typed  TEXT NOT NULL,
    state        TEXT NOT NULL,
    reported_on  TEXT NOT NULL,
    location     TEXT,
    notes        TEXT,
    photo1       TEXT,
    photo2       TEXT,
    reported_by  TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    deleted_at   TEXT,
    deleted_by   TEXT
  )`);

db.run(`CREATE INDEX IF NOT EXISTS idx_plate_reports_plate ON plate_reports(plate, reported_on)`);

/**
 * What the car looks like, added after the fact.
 *
 * A plate identifies a car but says nothing anyone can recognise from a
 * window. "The grey Mazda" is how a car is actually discussed, and it is what
 * makes a report legible to somebody who wasn't standing there — including the
 * neighbour being asked to stop.
 *
 * Added one at a time so this file can gain another later without a second
 * migration. Existing rows keep NULL rather than being guessed at.
 */
const plateColumns = new Set(
  (db.query(`PRAGMA table_info(plate_reports)`).all() as { name: string }[]).map((c) => c.name)
);
if (plateColumns.size) {
  for (const column of ["color", "year", "make", "model"]) {
    if (!plateColumns.has(column)) db.run(`ALTER TABLE plate_reports ADD COLUMN ${column} TEXT`);
  }
}

/**
 * Cars that are allowed in the driveway: tenants, a vendor who visits weekly,
 * somebody's own car.
 *
 * Without this the log fills up with the same handful of legitimate plates and
 * the red stops meaning anything — which is the only thing the plate page is
 * for. `plate` is normalised the same way `plate_reports.plate` is, so the two
 * join on a plate however it was typed.
 *
 * `label` is whose car it is, and is the reason this table is worth having
 * over a mental list: six months on, "Unit 3, blue Civic" is what tells you
 * whether the exception still applies.
 */
db.run(`
  CREATE TABLE IF NOT EXISTS plate_whitelist (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    plate        TEXT NOT NULL,
    plate_typed  TEXT NOT NULL,
    state        TEXT NOT NULL,
    label        TEXT NOT NULL,
    added_by     TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    removed_at   TEXT,
    removed_by   TEXT
  )`);

db.run(`CREATE INDEX IF NOT EXISTS idx_plate_whitelist ON plate_whitelist(plate)`);
