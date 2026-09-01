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
import { canEditTenants, displayName, FAVICON_LINK, trustedOrigins, type User } from "./auth";
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

/**
 * Where the checklist form is served from *this* app.
 *
 * The form itself has to run on :3100 — that is where uploads, drafts and
 * signing live — but :3100 is bound to localhost, so a browser in the office
 * can't open it. Anything on it that the office needs therefore comes through
 * here, the way the PDFs and the photos already do. This is the prefix that
 * gets stripped before the request is passed on.
 */
const CHECKLIST_PREFIX = "/checklist";

/**
 * The link that starts a new checklist as a copy of this one — same property,
 * same agent, same rooms with what was recorded about each of them, same
 * photos, and the tenant's name there to be changed. It is a path on this app,
 * not an address on :3100: the person following it is signed in here.
 *
 * The checklist is still filled in and signed by the app on the other end.
 * Nothing in this app writes to `checklists.db`.
 */
const copyUrl = (id: string) => `${CHECKLIST_PREFIX}/?copy=${id}`;

/** Requests this app hands straight to the checklist app. */
export const isChecklistPath = (pathname: string) =>
  pathname === CHECKLIST_PREFIX || pathname.startsWith(`${CHECKLIST_PREFIX}/`);

/**
 * The checklist form, served through the sign-in.
 *
 * A move-out walkthrough starts from a signed report — the Duplicate link on
 * every inspection — and it is walked by somebody from the office, on the
 * address they reach this app at. The form can't be handed to them on :3100:
 * that port answers only to this machine, which is exactly what makes it safe
 * to leave without a sign-in of its own.
 *
 * So everything under /checklist is passed on with the prefix taken off, and
 * the checklist app is told which prefix that was, so the page it serves asks
 * for /checklist/api/... rather than /api/... The request has already been
 * through this app's sign-in by the time it gets here; nothing about the
 * checklist app's own routes changes.
 *
 * The body is streamed rather than read: a walkthrough uploads photos and the
 * occasional video, and buffering a 200MB file here to send it on again would
 * cost this app the memory for no purpose.
 */
export async function proxyChecklistApp(req: Request, url: URL): Promise<Response> {
  const path = url.pathname.slice(CHECKLIST_PREFIX.length) || "/";
  const headers = new Headers();
  // Only what the checklist app reads. The session cookie in particular stays
  // here: it is this app's, and :3100 has no business being handed it.
  for (const name of ["content-type", "content-length", "accept", "user-agent"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("X-Forwarded-Prefix", CHECKLIST_PREFIX);

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : req.body;
  try {
    const res = await fetch(`${CHECKLIST_URL}${path}${url.search}`, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      // Sending a body that is still arriving.
      ...(body ? { duplex: "half" } : {}),
    } as RequestInit);
    const out = new Headers(res.headers);
    // Whatever the checklist app says about caching, nothing that comes
    // through here — a form with a tenant's answers in it, a photo of somebody's
    // flat — belongs in a shared cache.
    out.set("Cache-Control", "no-store, private");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  } catch (err) {
    console.warn(`Could not reach the checklist app at ${CHECKLIST_URL}.`, err);
    return new Response(
      "The checklist app isn't answering, so a checklist can't be filled in right now. " +
        "It runs as pcc.service on :3100; the reports already signed are unaffected.",
      { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store, private" } }
    );
  }
}

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
  /** Anyone else who signed on the day — a co-tenant, a witness. */
  extraSignatures?: { name: string; role: string; signature: string }[];
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

/* ---------------------------------------------------------- later signatures */

/**
 * Signatures put to an inspection after it was signed.
 *
 * The agent is often not at the walkthrough — the PDF prints them a line to
 * sign on paper — and a co-tenant, a witness or a contractor may put their name
 * to what was found days later. Until now the only way to record that was a
 * comment saying somebody had signed, which is not the same thing as a
 * signature.
 *
 * What they cannot do is change the report. The conditions and the notes are
 * what was recorded on the day, in a database this app only reads; a later
 * signature is added beside them, with a remark of its own, and prints in the
 * addendum after the signed pages. Nothing about the signed document moves.
 */
export type LaterSignature = {
  id: number;
  name: string;
  role: string;
  remark: string;
  /** The PNG the canvas produced, as a data URL. */
  signature: string;
  signedAt: string;
  /** The account that captured it, or that sent the link it came in through. */
  addedBy: string;
  addedByName: string | null;
  /** Set when it was signed remotely, through a link the office sent out. */
  linkId: number | null;
};

/** Room for what somebody signing a week later wants to put on the record. */
export const REMARK_MAX = 2000;
const SIGNER_MAX = 120;
const ROLE_MAX = 80;
/** A canvas signature is a few KB. This is slack, not a target. */
const SIGNATURE_MAX = 400_000;

/**
 * Offered in the page, not enforced here: the roles people actually sign as,
 * with the field left free text for the one that isn't on the list.
 */
export const SIGNER_ROLES = [
  "Agent / landlord representative",
  "Tenant",
  "Co-tenant",
  "Witness",
  "Contractor",
];

const insertSignature = db.query(
  `INSERT INTO inspection_signatures
     (checklist_id, signer_name, role, remark, signature, signed_at, added_by, added_by_name, link_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
   RETURNING id, signer_name, role, remark, signature, signed_at, added_by, added_by_name, link_id`
);
const listSignatures = db.query(
  `SELECT id, signer_name, role, remark, signature, signed_at, added_by, added_by_name, link_id
   FROM inspection_signatures WHERE checklist_id = ? AND deleted_at IS NULL ORDER BY id`
);
// Names as well as counts: "who signed this afterwards" is a thing somebody
// searches the list for, and the table is small enough to read whole.
const allSignatures = db.query(
  `SELECT checklist_id, signer_name, role FROM inspection_signatures
   WHERE deleted_at IS NULL ORDER BY id`
);
const readSignature = db.query(
  `SELECT id, checklist_id, added_by, deleted_at FROM inspection_signatures WHERE id = ?`
);
const softDeleteSignature = db.query(
  `UPDATE inspection_signatures SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL`
);

type SignatureRow = {
  id: number; signer_name: string; role: string; remark: string; signature: string;
  signed_at: string; added_by: string; added_by_name: string | null; link_id: number | null;
};

const toSignature = (r: SignatureRow): LaterSignature => ({
  id: r.id,
  name: r.signer_name,
  role: r.role,
  remark: r.remark ?? "",
  signature: r.signature,
  signedAt: r.signed_at,
  addedBy: r.added_by,
  addedByName: r.added_by_name,
  linkId: r.link_id,
});

export function inspectionSignatures(checklistId: string): LaterSignature[] {
  return (listSignatures.all(checklistId) as SignatureRow[]).map(toSignature);
}

/** How many signed each inspection afterwards, and who — one query for the list. */
function signatureSummary(): Map<string, { count: number; who: string }> {
  const summary = new Map<string, { count: number; who: string }>();
  for (const row of allSignatures.all() as {
    checklist_id: string; signer_name: string; role: string;
  }[]) {
    const seen = summary.get(row.checklist_id) ?? { count: 0, who: "" };
    seen.count++;
    seen.who = `${seen.who} ${row.signer_name} ${row.role}`.trim();
    summary.set(row.checklist_id, seen);
  }
  return summary;
}

/** A signature is a PNG from a canvas, or it is not a signature. */
const isSignature = (value: string) =>
  /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) && value.length >= 200;

/**
 * Records a signature against an inspection that has already been signed.
 *
 * Anyone signed in may add one, and it is attributed twice: to the person whose
 * name is on it, and to the account that captured it — often not the same
 * person, since a tenant signs on somebody else's laptop. Both are printed, so
 * the addendum never implies that a signature appeared by itself.
 */
export function addInspectionSignature(
  checklistId: string,
  user: User,
  input: { name?: unknown; role?: unknown; remark?: unknown; signature?: unknown }
): { signature: LaterSignature } | { error: string; status: number } {
  if (!readInspection(checklistId)) {
    return { error: "That inspection no longer exists — reload the page.", status: 404 };
  }

  const name = String(input?.name ?? "").trim();
  const role = String(input?.role ?? "").trim();
  const remark = String(input?.remark ?? "").trim();
  const signature = String(input?.signature ?? "");

  if (!name) return { error: "Who is signing? A signature needs a name against it.", status: 400 };
  if (name.length > SIGNER_MAX) {
    return { error: `A name can be at most ${SIGNER_MAX} characters.`, status: 400 };
  }
  if (!role) return { error: "Say what they are signing as.", status: 400 };
  if (role.length > ROLE_MAX) return { error: `A role can be at most ${ROLE_MAX} characters.`, status: 400 };
  if (remark.length > REMARK_MAX) {
    return { error: `A remark can be at most ${REMARK_MAX} characters.`, status: 400 };
  }
  if (!isSignature(signature)) return { error: "Sign in the box before saving.", status: 400 };
  if (signature.length > SIGNATURE_MAX) {
    return { error: "That signature is too large to store.", status: 413 };
  }

  const row = insertSignature.get(
    checklistId,
    name,
    role,
    remark,
    signature,
    new Date().toISOString(),
    user.username,
    displayName(user),
    null
  ) as SignatureRow;
  console.log(
    `[${new Date().toISOString()}] inspection ${checklistId.slice(0, 8)} signed by ${name} ` +
      `(${role}), captured by ${user.username} (signature ${row.id})`
  );
  return { signature: toSignature(row) };
}

/**
 * Removes a later signature from the page and from future addenda. Soft, and
 * only the account that captured it or Dan: one that has already gone out on a
 * PDF shouldn't be able to vanish as though it was never made.
 */
export function deleteInspectionSignature(
  checklistId: string,
  signatureId: number,
  user: User
): { ok: true } | { error: string; status: number } {
  const row = readSignature.get(signatureId) as
    | { id: number; checklist_id: string; added_by: string; deleted_at: string | null }
    | undefined;
  if (!row || row.checklist_id !== checklistId || row.deleted_at) {
    return { error: "That signature is already gone — reload the page.", status: 404 };
  }
  if (row.added_by !== user.username && !canEditTenants(user)) {
    return { error: "You can only remove a signature you added.", status: 403 };
  }
  softDeleteSignature.run(new Date().toISOString(), user.username, signatureId);
  console.log(
    `[${new Date().toISOString()}] inspection ${checklistId.slice(0, 8)} signature ${signatureId} ` +
      `removed by ${user.username}`
  );
  return { ok: true };
}

/* ------------------------------------------------------- links out to sign */

/**
 * A link handed to somebody outside the office so they can sign an inspection
 * themselves.
 *
 * The people whose signatures are missing are exactly the people who have no
 * account here: the tenant who has moved out, the landlord, the contractor who
 * saw the damage. Making them one to collect a signature is worse than the
 * problem it solves, and "print it, sign it, scan it back" is how a
 * countersignature never arrives at all.
 *
 * So the token is the authority, the same bargain as the checklist PDF links:
 * unguessable, and the credential itself. Each one is kept narrow — one
 * inspection, one signature, an expiry, and revocable from the report at any
 * time.
 */
export type SignLink = {
  id: number;
  token: string;
  signerName: string;
  role: string;
  createdAt: string;
  createdBy: string;
  createdByName: string | null;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  /** What the report shows about it now, which is the only thing the page needs. */
  state: "waiting" | "signed" | "expired" | "revoked";
};

/** Long enough that a walkthrough's countersignature isn't chased twice. */
const LINK_DAYS = 14;

const insertLink = db.query(
  `INSERT INTO inspection_sign_links
     (token, checklist_id, signer_name, role, created_at, created_by, created_by_name, expires_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   RETURNING id, token, signer_name, role, created_at, created_by, created_by_name,
             expires_at, used_at, revoked_at`
);
const listLinks = db.query(
  `SELECT id, token, signer_name, role, created_at, created_by, created_by_name,
          expires_at, used_at, revoked_at
   FROM inspection_sign_links WHERE checklist_id = ? ORDER BY id`
);
const readLinkByToken = db.query(
  `SELECT id, token, checklist_id, signer_name, role, created_at, created_by, created_by_name,
          expires_at, used_at, revoked_at
   FROM inspection_sign_links WHERE token = ?`
);
const readLinkById = db.query(
  `SELECT id, checklist_id, created_by, used_at, revoked_at FROM inspection_sign_links WHERE id = ?`
);
/* Claiming and recording are two steps on purpose: the claim is the atomic
   one, so two taps on a slow phone can't produce two signatures. */
const claimLink = db.query(
  `UPDATE inspection_sign_links SET used_at = ?
   WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`
);
const attachSignature = db.query(
  `UPDATE inspection_sign_links SET signature_id = ? WHERE id = ?`
);
const revokeLink = db.query(
  `UPDATE inspection_sign_links SET revoked_at = ?, revoked_by = ?
   WHERE id = ? AND revoked_at IS NULL AND used_at IS NULL`
);

type LinkRow = {
  id: number; token: string; signer_name: string; role: string; created_at: string;
  created_by: string; created_by_name: string | null; expires_at: string;
  used_at: string | null; revoked_at: string | null;
};

const toLink = (r: LinkRow): SignLink => ({
  id: r.id,
  token: r.token,
  signerName: r.signer_name,
  role: r.role,
  createdAt: r.created_at,
  createdBy: r.created_by,
  createdByName: r.created_by_name,
  expiresAt: r.expires_at,
  usedAt: r.used_at,
  revokedAt: r.revoked_at,
  state: r.revoked_at
    ? "revoked"
    : r.used_at
      ? "signed"
      : new Date(r.expires_at).getTime() < Date.now()
        ? "expired"
        : "waiting",
});

export function inspectionSignLinks(checklistId: string): SignLink[] {
  return (listLinks.all(checklistId) as LinkRow[]).map(toLink);
}

/**
 * Where a link points. Built from the address this app is actually reached on
 * rather than from the request, because the request that creates a link often
 * arrives over localhost or through a proxy — and a link to 127.0.0.1 is the
 * kind of thing somebody sends to a tenant once.
 */
export function signLinkUrl(token: string, origin?: string): string {
  const base = (trustedOrigins[0] ?? origin ?? "").replace(/\/+$/, "");
  return `${base}/sign/${token}`;
}

/**
 * A new link. The token is 32 random bytes: it is the whole of the security
 * here, so it is not a counter, a name or anything a person could arrive at by
 * trying.
 */
export function createSignLink(
  checklistId: string,
  user: User,
  input: { name?: unknown; role?: unknown }
): { link: SignLink } | { error: string; status: number } {
  if (!readInspection(checklistId)) {
    return { error: "That inspection no longer exists — reload the page.", status: 404 };
  }
  const name = String(input?.name ?? "").trim().slice(0, 120);
  const role = String(input?.role ?? "").trim().slice(0, 80);
  if (!name) return { error: "Who is the link for? Their name goes on the signature.", status: 400 };
  if (!role) return { error: "Say what they will be signing as.", status: 400 };

  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + LINK_DAYS * 24 * 60 * 60 * 1000);
  const row = insertLink.get(
    token, checklistId, name, role, now.toISOString(),
    user.username, displayName(user), expires.toISOString()
  ) as LinkRow;
  // The token is deliberately not logged: it is a credential, and this log is
  // read by more people than the link was sent to.
  console.log(
    `[${now.toISOString()}] inspection ${checklistId.slice(0, 8)} sign link ${row.id} created by ` +
      `${user.username} for ${name} (${role}), expires ${expires.toISOString().slice(0, 10)}`
  );
  return { link: toLink(row) };
}

/** Withdraws a link that hasn't been used. */
export function revokeSignLink(
  checklistId: string,
  linkId: number,
  user: User
): { ok: true } | { error: string; status: number } {
  const row = readLinkById.get(linkId) as
    | { id: number; checklist_id: string; created_by: string; used_at: string | null; revoked_at: string | null }
    | undefined;
  if (!row || row.checklist_id !== checklistId) {
    return { error: "That link is already gone — reload the page.", status: 404 };
  }
  if (row.used_at) return { error: "That link has already been signed; it can't be withdrawn.", status: 409 };
  if (row.revoked_at) return { error: "That link was already withdrawn.", status: 404 };
  if (row.created_by !== user.username && !canEditTenants(user)) {
    return { error: "You can only withdraw a link you sent.", status: 403 };
  }
  revokeLink.run(new Date().toISOString(), user.username, linkId);
  console.log(
    `[${new Date().toISOString()}] inspection ${checklistId.slice(0, 8)} sign link ${linkId} withdrawn by ${user.username}`
  );
  return { ok: true };
}

/** The link behind a token, with why it can't be used where that's the case. */
function openLink(token: string):
  | { link: SignLink; inspection: Inspection }
  | { refusal: "unknown" | "signed" | "expired" | "revoked" | "gone" } {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return { refusal: "unknown" };
  const row = readLinkByToken.get(token) as (LinkRow & { checklist_id: string }) | undefined;
  if (!row) return { refusal: "unknown" };
  const link = toLink(row);
  if (link.state !== "waiting") return { refusal: link.state };
  const inspection = readInspection(row.checklist_id);
  if (!inspection) return { refusal: "gone" };
  return { link, inspection };
}

/**
 * What a link's holder sees, or why they see nothing: everything the page
 * needs, so the routing does no reasoning of its own.
 */
export type SignInvitation =
  | { link: SignLink; inspection: Inspection }
  | { refusal: "unknown" | "signed" | "expired" | "revoked" | "gone" };

export const readSignInvitation = (token: string): SignInvitation => openLink(token);

/**
 * A signature made by whoever holds the link.
 *
 * The name is theirs to correct — the office types other people's names wrong
 * — but the capacity is not: the link was made to collect a particular
 * signature, and letting the holder rewrite that would make it a different
 * document from the one that was asked for. Both are kept: what the link was
 * for, and what they signed as.
 */
export function signByLink(
  token: string,
  input: { name?: unknown; remark?: unknown; signature?: unknown }
): { signature: LaterSignature } | { error: string; status: number } {
  const opened = openLink(token);
  if ("refusal" in opened) {
    const said = {
      unknown: "That link isn't valid.",
      signed: "That link has already been signed.",
      expired: "That link has expired.",
      revoked: "That link was withdrawn.",
      gone: "That inspection is no longer here.",
    }[opened.refusal];
    return { error: `${said} Ask the office for a new one.`, status: opened.refusal === "unknown" ? 404 : 410 };
  }
  const { link, inspection } = opened;

  const name = String(input?.name ?? "").trim() || link.signerName;
  const remark = String(input?.remark ?? "").trim();
  const signature = String(input?.signature ?? "");
  if (name.length > 120) return { error: "That name is too long.", status: 400 };
  if (remark.length > REMARK_MAX) {
    return { error: `A remark can be at most ${REMARK_MAX} characters.`, status: 400 };
  }
  if (!isSignature(signature)) return { error: "Sign in the box before saving.", status: 400 };
  if (signature.length > SIGNATURE_MAX) return { error: "That signature is too large to store.", status: 413 };

  // Claimed before it is recorded: two taps on a slow phone must not put two
  // signatures on a report.
  const now = new Date().toISOString();
  if (claimLink.run(now, link.id).changes !== 1) {
    return { error: "That link has already been signed. Ask the office for a new one.", status: 410 };
  }

  const row = insertSignature.get(
    inspection.id, name, link.role, remark, signature, now,
    link.createdBy, link.createdByName, link.id
  ) as SignatureRow;
  attachSignature.run(row.id, link.id);
  console.log(
    `[${now}] inspection ${inspection.id.slice(0, 8)} signed remotely by ${name} (${link.role}) ` +
      `through link ${link.id}, sent by ${link.createdBy} (signature ${row.id})`
  );
  return { signature: toSignature(row) };
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

/** The shared page chrome. Also used by the plates page. */
export const PAGE_CSS = `
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
    .pdf-link:hover { background: #374151; }

    /* Starting another checklist from this one. Quieter than the PDF: it is
       the occasional action, not the one every row is here for. */
    .copy-link { display: inline-block; background: #fff; border: 1px solid #d1d5db; border-radius: 6px;
      padding: 0.26rem 0.6rem; font: 600 0.78rem system-ui, sans-serif; color: #374151;
      text-decoration: none; white-space: nowrap; }
    .copy-link:hover { border-color: #9ca3af; color: var(--ink); }`;

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
    td.actions .stack { display: flex; flex-direction: column; align-items: flex-end; gap: 0.35rem; }
    .flag { display: inline-block; padding: 0.05rem 0.4rem; border-radius: 999px; font-size: 0.75rem;
      font-weight: 600; margin: 0 0.25rem 0.2rem 0; white-space: nowrap; }
    .flag.poor { background: #fee2e2; color: #991b1b; }
    .flag.blank { background: #f3f4f6; color: #6b7280; }
    .flag.media { background: #eef2fb; color: #2b4a9b; }
    .flag.clean { background: #e3f6e5; color: #1e7d32; }
    .flag.note { background: #fef3c7; color: #92400e; }
    .flag.sign { background: #ede9fe; color: #5b21b6; }
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
    .head .unsigned-note { color: #a16207; }
    .pdf-links { display: flex; flex-direction: column; align-items: flex-end; gap: 0.3rem; }
    .pdf-links .plain { font-size: 0.75rem; color: var(--muted); text-align: right; max-width: 20rem; }

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

    /* Signatures put to the report after it was signed. Apart from the ones
       above them, and marked in a different colour from the comments, because
       a signature is a stronger claim than a remark. */
    .later { border-left: 3px solid #6d28d9; }
    .later .why { margin: -0.35rem 0 0.9rem; color: var(--muted); font-size: 0.82rem; }
    .later-sig { display: flex; flex-wrap: wrap; gap: 0.9rem; align-items: flex-start;
      border-top: 1px solid #f1f2f4; padding: 0.8rem 0; }
    .later-sig:first-of-type { border-top: 0; padding-top: 0.2rem; }
    .later-sig img { flex: none; width: 190px; height: 62px; object-fit: contain; object-position: left bottom;
      border-bottom: 1px solid #cbd5e1; }
    .later-sig .detail { flex: 1 1 14rem; }
    .later-sig .who { margin: 0; font-size: 0.9rem; font-weight: 600; }
    .later-sig .who .role { margin-left: 0.4rem; font-weight: 400; color: var(--muted); font-size: 0.8rem; }
    .later-sig .at { display: flex; align-items: baseline; gap: 0.5rem; margin: 0.15rem 0 0;
      color: var(--muted); font-size: 0.78rem; }
    .later-sig .body { margin: 0.4rem 0 0; white-space: pre-wrap; font-size: 0.9rem; color: #374151; }
    .later-sig .drop { margin-left: auto; background: none; border: 0; padding: 0; cursor: pointer;
      color: var(--muted); font: inherit; font-size: 0.78rem; text-decoration: underline; }
    .later-sig .drop:hover { color: #991b1b; }
    .later-sig .drop[disabled] { opacity: 0.5; cursor: default; }

    .add-sig { margin-top: 0.9rem; border-top: 1px solid #f1f2f4; padding-top: 0.6rem; }
    .add-sig > summary { cursor: pointer; font: 600 0.85rem system-ui, sans-serif; color: #374151;
      padding: 0.2rem 0; }
    .add-sig > summary:hover { color: var(--ink); }
    .add-sig .fields { display: flex; flex-wrap: wrap; gap: 0.7rem; margin: 0.7rem 0 0; }
    .add-sig .field { flex: 1 1 14rem; }
    .add-sig label { display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--muted); font-weight: 600; margin: 0 0 0.25rem; }
    .add-sig input, .add-sig textarea { width: 100%; padding: 0.45rem 0.6rem; border: 1px solid #d1d5db;
      border-radius: 6px; font: inherit; font-size: 0.9rem; background: #fff; }
    .add-sig textarea { min-height: 4rem; resize: vertical; }
    .add-sig input:focus, .add-sig textarea:focus { outline: 2px solid #93c5fd; outline-offset: -1px;
      border-color: transparent; }
    /* The box is signed in with a finger, a stylus or a mouse; touch-action
       keeps a finger drawing rather than scrolling the page away. */
    .sigwrap { position: relative; height: 130px; margin-top: 0.7rem; border: 1px dashed #cbd5e1;
      border-radius: 8px; background: #fff; }
    .sigwrap canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: crosshair; }
    .sigwrap .line { position: absolute; left: 1rem; right: 1rem; bottom: 1.9rem; border-bottom: 1px solid #e5e7eb; }
    .sigwrap .prompt { position: absolute; left: 1rem; bottom: 0.55rem; color: var(--muted);
      font-size: 0.75rem; pointer-events: none; }
    .add-sig .row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin-top: 0.6rem; }
    .add-sig button { background: #1f2937; color: #fff; border: 0; border-radius: 6px;
      padding: 0.42rem 0.85rem; font: 600 0.82rem system-ui, sans-serif; cursor: pointer; }
    .add-sig button:hover { background: #374151; }
    .add-sig button[disabled] { opacity: 0.6; cursor: default; }
    .add-sig button.ghost { background: #fff; color: #374151; border: 1px solid #d1d5db; }
    .add-sig button.ghost:hover { background: #f9fafb; color: var(--ink); }
    .add-sig .opt { font-weight: 400; text-transform: none; letter-spacing: 0; }

    /* Links sent out so somebody who isn't here can sign it themselves. */
    .sign-link { border-top: 1px solid #f1f2f4; padding: 0.7rem 0; }
    .sign-link .who { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.45rem; margin: 0; }
    .sign-link .who { font-size: 0.9rem; font-weight: 600; }
    .sign-link .role { font-weight: 400; color: var(--muted); font-size: 0.8rem; }
    .sign-link .state { font-size: 0.72rem; font-weight: 600; padding: 0.05rem 0.4rem; border-radius: 999px; }
    .sign-link .state.waiting { background: #ede9fe; color: #5b21b6; }
    .sign-link .state.signed { background: #e3f6e5; color: #1e7d32; }
    .sign-link .state.expired, .sign-link .state.revoked { background: #f3f4f6; color: #6b7280; }
    .sign-link .at { display: flex; align-items: baseline; gap: 0.5rem; margin: 0.15rem 0 0;
      color: var(--muted); font-size: 0.78rem; }
    .sign-link .drop { margin-left: auto; background: none; border: 0; padding: 0; cursor: pointer;
      color: var(--muted); font: inherit; font-size: 0.78rem; text-decoration: underline; }
    .sign-link .drop:hover { color: #991b1b; }
    .sign-link .url { display: flex; gap: 0.4rem; margin-top: 0.45rem; }
    .sign-link .url input { flex: 1 1 auto; min-width: 0; padding: 0.35rem 0.5rem; border: 1px solid #d1d5db;
      border-radius: 6px; font: inherit; font-size: 0.78rem; color: #374151; background: #f9fafb; }
    .sign-link .url button { flex: none; background: #fff; color: #374151; border: 1px solid #d1d5db;
      border-radius: 6px; padding: 0.3rem 0.6rem; font: 600 0.78rem system-ui, sans-serif; cursor: pointer; }
    .sign-link .url button:hover { border-color: #9ca3af; color: var(--ink); }
    .add-sig .hint { color: var(--muted); font-size: 0.78rem; }
    .add-sig .err { color: #991b1b; font-size: 0.8rem; }

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

/**
 * One signature added after the fact, as it appears on the page and as it comes
 * back from the API when a new one is saved.
 */
export function renderLaterSignature(sig: LaterSignature, user: User): string {
  const mine = sig.addedBy === user.username || canEditTenants(user);
  const when = `${signedDate(sig.signedAt)} at ${signedTime(sig.signedAt)}`;
  return `
      <article class="later-sig" data-signature="${sig.id}">
        <img src="${escapeAttr(sig.signature)}" alt="${escapeAttr(`${sig.name} signature`)}" />
        <div class="detail">
          <p class="who">${escapeHtml(sig.name)}<span class="role">${escapeHtml(sig.role)}</span></p>
          <p class="at">Signed ${escapeHtml(when)} &middot; ${
            sig.linkId
              ? `signed remotely, on a link sent by ${escapeHtml(sig.addedByName || sig.addedBy)}`
              : `captured by ${escapeHtml(sig.addedByName || sig.addedBy)}`
          }${mine ? `<button type="button" class="drop" data-act="delete-signature">Remove</button>` : ""}</p>
          ${sig.remark ? `<p class="body">${escapeHtml(sig.remark)}</p>` : ""}
        </div>
      </article>`;
}

/**
 * One outstanding (or spent) link on the report page. The address itself is
 * only shown while the link can still be used: a spent link is a fact about
 * what happened, not something to send to anybody else.
 */
export function renderSignLink(link: SignLink, user: User): string {
  const mine = link.createdBy === user.username || canEditTenants(user);
  const said = {
    waiting: `Waiting &middot; expires ${escapeHtml(signedDate(link.expiresAt))}`,
    signed: `Signed ${escapeHtml(signedDate(link.usedAt ?? link.createdAt))}`,
    expired: `Expired ${escapeHtml(signedDate(link.expiresAt))}`,
    revoked: `Withdrawn ${escapeHtml(signedDate(link.revokedAt ?? link.createdAt))}`,
  }[link.state];
  const url = signLinkUrl(link.token);
  return `
      <article class="sign-link" data-link="${link.id}">
        <p class="who">${escapeHtml(link.signerName)}<span class="role">${escapeHtml(link.role)}</span>
          <span class="state ${link.state}">${said}</span></p>
        <p class="at">Sent by ${escapeHtml(link.createdByName || link.createdBy)} on
          ${escapeHtml(signedDate(link.createdAt))}${
            mine && link.state === "waiting"
              ? `<button type="button" class="drop" data-act="revoke-link">Withdraw</button>`
              : ""
          }</p>
        ${
          link.state === "waiting"
            ? `<div class="url">
          <input type="text" readonly value="${escapeAttr(url)}" aria-label="Signing link for ${escapeAttr(
            link.signerName
          )}" />
          <button type="button" data-act="copy-link">Copy</button>
        </div>`
            : ""
        }
      </article>`;
}

/**
 * Signing a report that has already been signed.
 *
 * The pad is the same idea as the one in the checklist app: a canvas backed at
 * device resolution and scaled down by CSS, so a line drawn with a finger or a
 * stylus is sharp rather than blocky. It is sized when the section is opened,
 * because a canvas inside a closed <details> measures zero.
 */
const SIGNATURES_JS = `
(function () {
  var card = document.getElementById("later-signatures");
  if (!card) return;
  /* The card is a long way down a report that runs to thousands of pixels, so
     the way in is a link at the top — and following it opens the pad rather
     than landing somebody next to a summary they then have to expand. */
  function reveal() {
    var open = document.getElementById("add-signature");
    if (open) open.open = true;
    card.scrollIntoView({ block: "start", behavior: "smooth" });
    var name = document.getElementById("sig-name");
    if (name) setTimeout(function () { try { name.focus({ preventScroll: true }); } catch (e) { name.focus(); } }, 250);
  }
  document.addEventListener("click", function (e) {
    var link = e.target.closest && e.target.closest('a[href="#sign"]');
    if (!link) return;
    e.preventDefault();
    reveal();
  });
  if (location.hash === "#sign") setTimeout(reveal, 60);
  var id = card.dataset.inspection;
  var list = document.getElementById("signature-list");
  var empty = document.getElementById("no-signatures");
  var count = document.getElementById("signature-count");
  var box = document.getElementById("add-signature");
  var nameField = document.getElementById("sig-name");
  var roleField = document.getElementById("sig-role");
  var remarkField = document.getElementById("sig-remark");
  var save = document.getElementById("save-signature");
  var clear = document.getElementById("clear-signature");
  var error = document.getElementById("signature-error");
  var prompt = document.getElementById("sig-prompt");
  var wrap = document.getElementById("sig-pad-wrap");
  var canvas = document.getElementById("sig-pad");
  var ctx = canvas.getContext("2d");
  var drawing = false, last = null, signed = false;

  function problem(message) {
    error.textContent = message || "";
    error.hidden = !message;
  }
  function retally() {
    var n = list.querySelectorAll(".later-sig").length;
    if (empty) empty.hidden = n !== 0;
    if (count) count.textContent = n === 0 ? "" : n + (n === 1 ? " signature added" : " signatures added");
  }

  /* Re-sizing clears the bitmap, so anything already drawn is put back. */
  function size() {
    var ratio = window.devicePixelRatio || 1;
    var w = wrap.clientWidth, h = wrap.clientHeight;
    if (!w || !h) return;
    var previous = signed ? canvas.toDataURL() : null;
    canvas.width = Math.round(Math.min(w, 2000) * ratio);
    canvas.height = Math.round(Math.min(h, 400) * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
    if (previous) {
      var img = new Image();
      img.onload = function () { ctx.drawImage(img, 0, 0, w, h); };
      img.src = previous;
    }
  }
  function wipe() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    signed = false;
    prompt.hidden = false;
  }
  function at(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* mouse without capture */ }
    drawing = true;
    last = at(e);
    prompt.hidden = true;
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!drawing) return;
    e.preventDefault();
    var p = at(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
    signed = true;
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (type) {
    canvas.addEventListener(type, function () { drawing = false; });
  });

  box.addEventListener("toggle", function () {
    if (box.open) requestAnimationFrame(size);
  });
  window.addEventListener("resize", function () { if (box.open) size(); });
  clear.addEventListener("click", wipe);

  save.addEventListener("click", function () {
    var name = nameField.value.trim();
    var role = roleField.value.trim();
    if (!name) { problem("Who is signing?"); nameField.focus(); return; }
    if (!role) { problem("Say what they are signing as."); roleField.focus(); return; }
    if (!signed) { problem("Sign in the box before saving."); return; }

    save.disabled = true;
    problem("");
    fetch("/api/inspections/" + id + "/signatures", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name, role: role, remark: remarkField.value.trim(),
        signature: canvas.toDataURL("image/png")
      })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "That signature wasn't saved.");
          return data;
        });
      })
      .then(function (data) {
        // Only cleared once the server has it: a failed save keeps the mark,
        // which cannot be drawn a second time exactly as it was.
        list.insertAdjacentHTML("beforeend", data.signature);
        retally();
        nameField.value = "";
        remarkField.value = "";
        wipe();
        box.open = false;
      })
      .catch(function (err) { problem(err.message); })
      .then(function () { save.disabled = false; });
  });

  /* ---- links out to whoever isn't here ---- */
  var linkList = document.getElementById("link-list");
  var linkBox = document.getElementById("send-link");
  var linkName = document.getElementById("link-name");
  var linkRole = document.getElementById("link-role");
  var makeLink = document.getElementById("make-link");
  var linkError = document.getElementById("link-error");

  function linkProblem(message) {
    linkError.textContent = message || "";
    linkError.hidden = !message;
  }

  makeLink.addEventListener("click", function () {
    var name = linkName.value.trim();
    var role = linkRole.value.trim();
    if (!name) { linkProblem("Who is the link for?"); linkName.focus(); return; }
    if (!role) { linkProblem("What will they be signing as?"); linkRole.focus(); return; }
    makeLink.disabled = true;
    linkProblem("");
    fetch("/api/inspections/" + id + "/sign-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, role: role })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "That link wasn't created.");
          return data;
        });
      })
      .then(function (data) {
        linkList.insertAdjacentHTML("beforeend", data.link);
        linkName.value = "";
        linkRole.value = "";
        linkBox.open = false;
        // Straight onto the clipboard where the browser allows it: the next
        // thing anybody does with a link they just made is paste it.
        var field = linkList.querySelector(".sign-link:last-child .url input");
        if (field) {
          field.focus();
          field.select();
          if (navigator.clipboard) navigator.clipboard.writeText(field.value).catch(function () {});
        }
      })
      .catch(function (err) { linkProblem(err.message); })
      .then(function () { makeLink.disabled = false; });
  });

  linkList.addEventListener("click", function (e) {
    var copy = e.target.closest('button[data-act="copy-link"]');
    if (copy) {
      var field = copy.parentElement.querySelector("input");
      field.focus();
      field.select();
      var done = function () { copy.textContent = "Copied"; setTimeout(function () { copy.textContent = "Copy"; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(field.value).then(done, function () {});
      else { try { document.execCommand("copy"); done(); } catch (err) { /* the field is selected either way */ } }
      return;
    }
    var withdraw = e.target.closest('button[data-act="revoke-link"]');
    if (!withdraw) return;
    var row = withdraw.closest(".sign-link");
    if (!window.confirm("Withdraw this link? Whoever has it will no longer be able to sign.")) return;
    withdraw.disabled = true;
    linkProblem("");
    fetch("/api/inspections/" + id + "/sign-links/" + row.dataset.link, { method: "DELETE" })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "That link wasn't withdrawn.");
          return data;
        });
      })
      .then(function (data) { row.outerHTML = data.link; })
      .catch(function (err) { withdraw.disabled = false; linkProblem(err.message); });
  });

  list.addEventListener("click", function (e) {
    var drop = e.target.closest('button[data-act="delete-signature"]');
    if (!drop) return;
    var article = drop.closest(".later-sig");
    if (!window.confirm("Remove this signature? It stops printing on the addendum.")) return;
    drop.disabled = true;
    problem("");
    fetch("/api/inspections/" + id + "/signatures/" + article.dataset.signature, { method: "DELETE" })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "That signature wasn't removed.");
        });
      })
      .then(function () { article.remove(); retally(); })
      .catch(function (err) { drop.disabled = false; problem(err.message); });
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
function listRow(i: Inspection, notes: number, signed: { count: number; who: string } | undefined): string {
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
    (notes ? `<span class="flag note">${notes} comment${notes === 1 ? "" : "s"}</span>` : "") +
    // A report somebody put their name to afterwards is a different document
    // from the one that was submitted, so the list says so too.
    (signed
      ? `<span class="flag sign">${signed.count} signed later</span>`
      : "");

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
    // Whoever put their name to it afterwards, so they can be searched for too.
    signed?.who ?? "",
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
          <td class="actions" data-label="Report"><div class="stack">
            <a class="pdf-link" href="/inspections/${escapeAttr(i.id)}.pdf" target="_blank" rel="noopener">PDF</a>
            <a class="copy-link" href="/inspections/${escapeAttr(i.id)}#sign"
              title="Add a signature to this report — the agent, a co-tenant, a witness">Sign</a>
            <a class="copy-link" href="${escapeAttr(copyUrl(i.id))}" target="_blank" rel="noopener"
              title="Start a new checklist from this one — same property, rooms, notes and photos">Duplicate</a>
          </div></td>
        </tr>`;
}

export function renderInspectionsList(nav: string, navCss: string): string {
  const inspections = listInspections();
  if (inspections === null) {
    return page("Inspections", nav, navCss, LIST_CSS, `  <h1>Inspections</h1>\n  ${UNREADABLE}`);
  }

  const withPoor = inspections.filter((i) => tally(i.checklist).poor > 0).length;
  const counts = noteCounts();
  const signed = signatureSummary();
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
            ? inspections
                .map((i) => listRow(i, counts.get(i.id) ?? 0, signed.get(i.id)))
                .join("") +
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
  const laterSignatures = inspectionSignatures(inspection.id);
  const links = inspectionSignLinks(inspection.id);
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
        ${c.agentName ? `&middot; agent ${escapeHtml(c.agentName)}` : "&middot; no agent present"}
        ${
          laterSignatures.length
            ? `&middot; <a href="#sign">${laterSignatures.length} signed later</a>`
            : c.agentName && !c.agentSignature
              ? `&middot; <span class="unsigned-note">the agent hasn&rsquo;t signed</span>`
              : ""
        }</p>
    </div>
    <div class="pdf-links">
      <a class="pdf-link" href="/inspections/${escapeAttr(inspection.id)}.pdf" target="_blank" rel="noopener">
        ${notes.length || laterSignatures.length ? "PDF with the addendum" : "Signed PDF"}</a>
      ${
        notes.length || laterSignatures.length
          ? `<a class="plain" href="/inspections/${escapeAttr(inspection.id)}.pdf?original=1"
        target="_blank" rel="noopener">As signed, without the addendum</a>`
          : ""
      }
      <a class="copy-link" href="#sign" id="jump-to-sign">${
        c.agentName && !c.agentSignature
          ? `Sign as ${escapeHtml(c.agentName)} &mdash; or anyone else`
          : "Sign this report"
      }</a>
      <a class="copy-link" href="${escapeAttr(copyUrl(inspection.id))}" target="_blank" rel="noopener"
        style="margin-top:0.25rem">Duplicate for the move-out</a>
      <span class="plain">Opens a new checklist with this property, agent, rooms,
        notes and photos already in it &mdash; change the tenant and what has changed.</span>
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
      ${(c.extraSignatures ?? [])
        .map((other) => signatureBlock(other.signature, other.name, other.role, when))
        .join("")}
    </div>
  </section>

  <h2 class="band">Signed after the walkthrough</h2>
  <section class="card later" id="later-signatures" data-inspection="${escapeAttr(inspection.id)}">
    <p class="why">Somebody who wasn&rsquo;t there when this was signed can put their name to it here &mdash;
      the agent who couldn&rsquo;t make the walkthrough, a co-tenant, a witness.
      <strong>Nothing above changes:</strong> the conditions and the notes are what was recorded on the day.
      A signature added here sits beside them, with a remark of its own if there is something to say, and
      prints in the addendum after the signed pages. <span id="signature-count">${
        laterSignatures.length
          ? `${laterSignatures.length} signature${laterSignatures.length === 1 ? "" : "s"} added`
          : ""
      }</span></p>
    <div id="signature-list">${laterSignatures.map((sig) => renderLaterSignature(sig, user)).join("")}</div>
    <p class="no-notes" id="no-signatures"${laterSignatures.length ? " hidden" : ""}>
      Nobody has signed this since it was submitted.</p>

    <details class="add-sig" id="add-signature">
      <summary>Add a signature</summary>
      <div class="fields">
        <div class="field">
          <label for="sig-name">Full name of the person signing</label>
          <input id="sig-name" type="text" maxlength="120" autocomplete="off"
            placeholder="${escapeAttr(c.agentName || "Their full name")}" />
        </div>
        <div class="field">
          <label for="sig-role">Signing as</label>
          <input id="sig-role" type="text" maxlength="80" autocomplete="off" list="sig-roles"
            value="${escapeAttr(c.agentName && !c.agentSignature ? SIGNER_ROLES[0] : "")}"
            placeholder="${escapeAttr(SIGNER_ROLES[0])}" />
          <datalist id="sig-roles">${SIGNER_ROLES.map(
            (role) => `<option value="${escapeAttr(role)}"></option>`
          ).join("")}</datalist>
        </div>
      </div>
      <div class="fields">
        <div class="field" style="flex-basis:100%">
          <label for="sig-remark">Anything they want on the record <span class="opt">optional</span></label>
          <textarea id="sig-remark" maxlength="${REMARK_MAX}"
            placeholder="What they are agreeing to, what they saw, what has been put right since&hellip;"></textarea>
        </div>
      </div>
      <div class="sigwrap" id="sig-pad-wrap">
        <canvas id="sig-pad"></canvas>
        <div class="line"></div>
        <span class="prompt" id="sig-prompt">Sign here</span>
      </div>
      <div class="row">
        <button type="button" id="save-signature">Add signature</button>
        <button type="button" class="ghost" id="clear-signature">Clear</button>
        <span class="hint">Captured by ${escapeHtml(displayName(user))} &middot;
          the record shows both names</span>
        <span class="err" id="signature-error" hidden></span>
      </div>
    </details>

    <div id="link-list">${links.map((link) => renderSignLink(link, user)).join("")}</div>

    <details class="add-sig" id="send-link">
      <summary>Send a link to someone who isn&rsquo;t here</summary>
      <p class="why" style="margin:0.6rem 0 0">They don&rsquo;t need an account. The link opens the
        report and one box to sign it, works once, and expires in a fortnight &mdash; and it can be
        withdrawn from here until it is used. Whoever holds it can read this inspection, so send it
        to the person it names and nobody else.</p>
      <div class="fields">
        <div class="field">
          <label for="link-name">Who is it for</label>
          <input id="link-name" type="text" maxlength="120" autocomplete="off"
            placeholder="${escapeAttr(c.agentName || "Their full name")}" />
        </div>
        <div class="field">
          <label for="link-role">They will sign as</label>
          <input id="link-role" type="text" maxlength="80" autocomplete="off" list="sig-roles"
            placeholder="${escapeAttr(SIGNER_ROLES[0])}" />
        </div>
      </div>
      <div class="row">
        <button type="button" id="make-link">Create the link</button>
        <span class="hint">Nothing is sent for you &mdash; copy it into your own email or text.</span>
        <span class="err" id="link-error" hidden></span>
      </div>
    </details>
  </section>
  <script>${SIGNATURES_JS}</script>

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

/* ------------------------------------------------------ the page a link opens */

/**
 * The page somebody outside the office sees when they follow a signing link.
 *
 * It carries no sign-in, no nav and nothing about any other property: whoever
 * holds the link gets this inspection and the box to sign it, and that is the
 * whole of what the token buys. Styled like the checklist form rather than the
 * CRM, because it is the same audience — a person on a phone, once.
 *
 * What they are signing is on the page above the box. A signature under a
 * summary somebody has to take on trust is worth less than one under the thing
 * itself, so the findings are printed in full and the signed PDF is one tap
 * away.
 */
const SIGN_CSS = `
    :root { --ink: #111827; --muted: #6b7280; --line: #e5e7eb; --bg: #f4f5f7; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--ink);
      font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
    .wrap { max-width: 640px; margin: 0 auto; padding: 0 16px 48px; }
    header { background: var(--ink); color: #fff; padding: 18px 0 16px; margin-bottom: 18px; }
    header .wrap { padding-bottom: 0; }
    header h1 { margin: 0; font-size: 1.05rem; letter-spacing: -0.01em; }
    header p { margin: 4px 0 0; color: #9ca3af; font-size: 0.82rem; }
    .card { background: #fff; border: 1px solid var(--line); border-radius: 12px;
      padding: 16px; margin: 0 0 14px; }
    .card h2 { margin: 0 0 6px; font-size: 1rem; }
    .sub { margin: 0 0 10px; color: var(--muted); font-size: 0.86rem; }
    .facts { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 14px; }
    .fact { flex: 1 1 6rem; background: #fff; border: 1px solid var(--line); border-radius: 10px;
      padding: 8px 10px; }
    .fact b { display: block; font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--muted); }
    .fact span { font-size: 1.1rem; font-weight: 600; }
    .fact.poor span { color: #991b1b; }
    ul.found { margin: 0; padding: 0; list-style: none; }
    ul.found li { padding: 7px 0; border-top: 1px solid #f1f2f4; font-size: 0.88rem; }
    ul.found li:first-child { border-top: 0; }
    ul.found .where { font-weight: 600; }
    ul.found .what { display: block; color: #374151; }
    .cond { display: inline-block; padding: 0.05rem 0.4rem; border-radius: 4px; font-size: 0.72rem;
      font-weight: 600; margin-right: 6px; }
    .cond.poor { background: #fee2e2; color: #991b1b; }
    .cond.fair { background: #fff4e0; color: #a15c00; }
    .btn { display: block; width: 100%; border: 0; border-radius: 12px; padding: 15px 16px;
      background: var(--ink); color: #fff; font: 600 1rem system-ui, sans-serif; text-align: center;
      text-decoration: none; cursor: pointer; }
    .btn[disabled] { opacity: 0.55; }
    .btn.ghost { background: #fff; color: var(--ink); border: 1px solid #cbd5e1; }
    label { display: block; margin: 12px 0 4px; font-size: 0.78rem; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--muted); font-weight: 600; }
    input, textarea { width: 100%; padding: 12px; border: 1px solid #cbd5e1; border-radius: 10px;
      font: inherit; background: #fff; }
    textarea { min-height: 84px; resize: vertical; }
    input:focus, textarea:focus { outline: 2px solid #93c5fd; outline-offset: -1px; border-color: transparent; }
    .sigwrap { position: relative; margin-top: 12px; border: 1px solid #cbd5e1; border-radius: 12px;
      background: #fff; overflow: hidden; }
    .sigwrap canvas { display: block; width: 100%; height: 190px; touch-action: none; }
    .sigwrap .baseline { position: absolute; left: 18px; right: 18px; bottom: 46px;
      border-bottom: 1px dashed #cbd5e1; }
    .sigwrap .hintline { position: absolute; left: 18px; bottom: 24px; color: #b6bdc7; font-size: 0.8rem; }
    .sigwrap.signed .baseline, .sigwrap.signed .hintline { display: none; }
    .err { margin: 10px 0 0; padding: 10px 12px; background: #fef2f2; border: 1px solid #fecaca;
      border-radius: 10px; color: #991b1b; font-size: 0.85rem; }
    .note { margin: 0 0 14px; padding: 12px 14px; background: #eef2fb; border: 1px solid #c9d7f5;
      border-radius: 12px; font-size: 0.86rem; color: #22386f; }
    .done { text-align: center; padding: 26px 16px; }
    .done .tick { width: 54px; height: 54px; margin: 0 auto 12px; border-radius: 50%; background: #e3f6e5;
      color: #1e7d32; font-size: 1.7rem; line-height: 54px; }
    footer.legal { color: var(--muted); font-size: 0.76rem; text-align: center; margin-top: 8px; }`;

/** A standalone page: no nav, no sign-in, nothing about anything else. */
function signPage(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="robots" content="noindex, nofollow" />
  <title>${escapeHtml(title)}</title>
  ${FAVICON_LINK}
  <style>${SIGN_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** Why a link doesn't work, said plainly and without a way to poke at it. */
export function renderSignRefusal(reason: "unknown" | "signed" | "expired" | "revoked" | "gone"): string {
  const said = {
    unknown: ["This link isn’t valid", "It may have been mistyped, or it may never have existed."],
    signed: ["This report has been signed", "That link has already been used. Nothing more is needed."],
    expired: ["This link has expired", "Signing links last two weeks, and this one is past that."],
    revoked: ["This link was withdrawn", "The office cancelled it."],
    gone: ["That report is no longer here", "It may have been removed since the link was sent."],
  }[reason];
  return signPage(
    said[0],
    `<header><div class="wrap"><h1>Property condition report</h1></div></header>
  <div class="wrap">
    <div class="card">
      <h2>${escapeHtml(said[0])}</h2>
      <p class="sub">${escapeHtml(said[1])} If you were asked to sign something, contact the office
        and they can send a new link.</p>
    </div>
  </div>`
  );
}

/** The page itself: the report, then the box to sign it. */
export function renderSignPage(link: SignLink, inspection: Inspection): string {
  const c = inspection.checklist;
  const t = tally(c);
  const found = defects(c);
  const wrote = written(c);
  const when = `${signedDate(inspection.createdAt)} at ${signedTime(inspection.createdAt)}`;

  const findings = found.length
    ? `<ul class="found">${found
        .map(
          (d) => `<li>${conditionPill(d.condition)}<span class="where">${escapeHtml(d.room)} &mdash;
            ${escapeHtml(d.label)}</span>${d.notes ? `<span class="what">${escapeHtml(d.notes)}</span>` : ""}</li>`
        )
        .join("")}</ul>`
    : `<p class="sub">Nothing was marked poor or fair.</p>`;

  const written_ = wrote.length
    ? `<div class="card"><h2>What else was written</h2>
      <ul class="found">${wrote
        .map(
          (w) => `<li><span class="where">${escapeHtml(w.where)}</span>
            <span class="what">${escapeHtml(w.what)}</span></li>`
        )
        .join("")}</ul></div>`
    : "";

  const body = `<header><div class="wrap">
    <h1>Property condition report</h1>
    <p>${escapeHtml(c.address)}</p>
  </div></header>
  <div class="wrap">
    <p class="note">${escapeHtml(link.createdByName || link.createdBy)} has asked you to sign this report
      as <strong>${escapeHtml(link.role)}</strong>. Signing adds your name to it.
      <strong>It changes nothing in the report</strong> &mdash; what is below was recorded on
      ${escapeHtml(signedDate(inspection.createdAt))} and can&rsquo;t be edited by you or by anyone else.
      If something here is wrong, say so in the box at the bottom rather than not signing: what you
      write is kept with your signature.</p>

    <div class="card">
      <h2>${escapeHtml(c.address)}</h2>
      <p class="sub">Walked and signed by ${escapeHtml(c.name)} on ${escapeHtml(when)}${
        c.agentName ? `, with ${escapeHtml(c.agentName)} for the office` : ""
      }.</p>
      <div class="facts">
        <div class="fact"><b>Rooms</b><span>${t.rooms}</span></div>
        <div class="fact"><b>Items</b><span>${t.items}</span></div>
        <div class="fact${t.poor ? " poor" : ""}"><b>Marked poor</b><span>${t.poor}</span></div>
        <div class="fact"><b>Photos</b><span>${t.photos}</span></div>
      </div>
      <a class="btn ghost" href="/sign/${escapeAttr(link.token)}.pdf" target="_blank" rel="noopener">
        Read the full report (PDF)</a>
      <p class="sub" style="margin:8px 0 0">The document as it was signed on the day, with every room,
        every rating and the photos.</p>
    </div>

    <div class="card">
      <h2>What the walkthrough found</h2>
      ${findings}
    </div>
    ${written_}
    ${
      c.generalNotes
        ? `<div class="card"><h2>General notes</h2><p class="sub" style="white-space:pre-wrap;color:#374151">${escapeHtml(
            c.generalNotes
          )}</p></div>`
        : ""
    }

    <div class="card" id="sign-card">
      <h2>Your signature</h2>
      <p class="sub">Signing as <strong>${escapeHtml(link.role)}</strong>.</p>
      <label for="s-name">Your full name</label>
      <input id="s-name" type="text" autocomplete="name" maxlength="120"
        value="${escapeAttr(link.signerName)}" />
      <label for="s-remark">Anything you want on the record <span style="text-transform:none">(optional)</span></label>
      <textarea id="s-remark" maxlength="${REMARK_MAX}"
        placeholder="What you agree with, what you disagree with, anything put right since&hellip;"></textarea>
      <div class="sigwrap" id="s-wrap">
        <canvas id="s-pad"></canvas>
        <div class="baseline"></div>
        <div class="hintline">Sign above the line</div>
      </div>
      <button type="button" class="btn ghost" id="s-clear" style="margin-top:10px">Clear</button>
      <p class="err" id="s-error" hidden></p>
      <button type="button" class="btn" id="s-save" style="margin-top:10px">Sign the report</button>
      <p class="sub" style="margin:10px 0 0">This link is for you and works once. It expires on
        ${escapeHtml(signedDate(link.expiresAt))}.</p>
    </div>

    <div class="card done" id="s-done" hidden>
      <div class="tick">&check;</div>
      <h2>Signed &mdash; thank you</h2>
      <p class="sub" id="s-done-sub">Your signature has been added to this report.</p>
      <a class="btn ghost" href="/sign/${escapeAttr(link.token)}.pdf" target="_blank" rel="noopener">
        Open the report (PDF)</a>
    </div>

    <footer class="legal">Your signature is added after the pages that were signed on the day.
      It does not alter them.</footer>
  </div>
  <script>${SIGN_JS.replace("__TOKEN__", link.token)}</script>`;

  return signPage(`Sign — ${c.address}`, body);
}

/**
 * The pad and the one request this page makes. Written the way the checklist
 * form's is — plain ES5, no build step, and a canvas backed at device
 * resolution so a finger line is sharp.
 */
const SIGN_JS = `
(function () {
  var token = "__TOKEN__";
  var canvas = document.getElementById("s-pad");
  var wrap = document.getElementById("s-wrap");
  var ctx = canvas.getContext("2d");
  var error = document.getElementById("s-error");
  var save = document.getElementById("s-save");
  var drawing = false, last = null, signed = false;

  function problem(message) {
    error.textContent = message || "";
    error.hidden = !message;
  }
  function size() {
    var ratio = window.devicePixelRatio || 1;
    var w = wrap.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    var previous = signed ? canvas.toDataURL() : null;
    canvas.width = Math.round(Math.min(w, 2000) * ratio);
    canvas.height = Math.round(Math.min(h, 400) * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
    if (previous) {
      var img = new Image();
      img.onload = function () { ctx.drawImage(img, 0, 0, w, h); };
      img.src = previous;
    }
  }
  function at(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  canvas.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    drawing = true;
    signed = true;
    last = at(e);
    // A tap with no movement still leaves a mark, or a dotted "i" vanishes.
    ctx.beginPath();
    ctx.arc(last.x, last.y, 1.1, 0, Math.PI * 2);
    ctx.fillStyle = "#111827";
    ctx.fill();
    wrap.classList.add("signed");
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* drawing works without it */ }
  });
  canvas.addEventListener("pointermove", function (e) {
    if (!drawing) return;
    e.preventDefault();
    var p = at(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last = p;
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (type) {
    canvas.addEventListener(type, function () { drawing = false; });
  });
  window.addEventListener("resize", size);
  size();

  document.getElementById("s-clear").addEventListener("click", function () {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    signed = false;
    wrap.classList.remove("signed");
  });

  save.addEventListener("click", function () {
    var name = document.getElementById("s-name").value.trim();
    if (!name) { problem("Please put your name in."); document.getElementById("s-name").focus(); return; }
    if (!signed) { problem("Sign in the box above first."); return; }
    problem("");
    save.disabled = true;
    save.textContent = "Signing\\u2026";
    fetch("/sign/" + token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name,
        remark: document.getElementById("s-remark").value.trim(),
        signature: canvas.toDataURL("image/png")
      })
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "That didn't save. Please try again.");
          return data;
        });
      })
      .then(function () {
        document.getElementById("sign-card").hidden = true;
        document.getElementById("s-done").hidden = false;
        document.getElementById("s-done").scrollIntoView({ block: "center", behavior: "smooth" });
      })
      .catch(function (err) {
        problem(err.message);
        save.disabled = false;
        save.textContent = "Sign the report";
      });
  });
})();`;

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
  const signatures = original ? [] : inspectionSignatures(id);
  let bytes = signed;
  if (notes.length || signatures.length) {
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
        notes,
        signatures
      );
    } catch (err) {
      // Something that can't be laid out must not cost anyone the signed
      // document; the page still shows every comment and signature either way.
      console.warn(`Could not append the addendum for ${id}; serving the signed PDF alone.`, err);
      bytes = signed;
    }
  }

  return new Response(bytes, {
    headers: {
      "Content-Type": "application/pdf",
      // Named so a file carrying an addendum can't be mistaken for the signed
      // copy once it's sitting in somebody's downloads folder.
      "Content-Disposition": `inline; filename="${
        notes.length || signatures.length ? name.replace(/\.pdf$/, "") + "_with-addendum.pdf" : name
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
