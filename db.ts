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
