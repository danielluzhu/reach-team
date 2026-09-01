/**
 * Property condition checklists — a tenant fills one in on their phone, signs
 * it, and gets a PDF.
 *
 * Deliberately separate from the CRM on :3000: this is the one page in the
 * estate a tenant is handed a link to, so it carries no tenant list, no door
 * codes and no sign-in. What it stores is what that tenant typed about the
 * property they are standing in.
 */
import { Database } from "bun:sqlite";
import { CONDITIONS, ROOM_TEMPLATES, defaultRooms, type RoomKind } from "./rooms";
import { ACKNOWLEDGEMENTS, CERTIFICATION } from "./legal";
import { buildChecklistPdf } from "./pdf";
import {
  MAX_ATTACHMENTS, MAX_PHOTO_BYTES, MAX_VIDEO_BYTES, UPLOAD_DIR,
  acceptedTypes, sweepOrphans, typeOf, uploadPath, type Attachment,
} from "./uploads";
import type { Checklist, ChecklistRoom } from "./types";

const db = new Database(process.env.DB_PATH ?? "checklists.db");
db.run("PRAGMA journal_mode = WAL");
db.run(`
  CREATE TABLE IF NOT EXISTS checklists (
    id          TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    address     TEXT NOT NULL,
    bedrooms    INTEGER NOT NULL,
    bathrooms   INTEGER NOT NULL,
    -- The whole submission, so a checklist can be re-rendered later even after
    -- the room templates in the code have moved on.
    data        TEXT NOT NULL
  )
`);

/**
 * Checklists that haven't been signed yet, pushed up as they're filled in.
 *
 * The browser keeps its own copy, but that copy is on one phone: when a
 * tenant couldn't submit, twenty minutes of work existed nowhere else and
 * nobody could see it or finish it for them. A draft here means the answers
 * are off the phone long before anyone presses a button.
 *
 * A draft is not a report — it has no signature and nobody has certified
 * anything. It only becomes a checklist through the normal signed route.
 */
db.run(`
  CREATE TABLE IF NOT EXISTS drafts (
    id         TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    name       TEXT,
    email      TEXT,
    address    TEXT,
    rooms      INTEGER NOT NULL DEFAULT 0,
    data       TEXT NOT NULL
  )
`);

const upsertDraft = db.query(
  `INSERT INTO drafts (id, created_at, updated_at, name, email, address, rooms, data)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET
     updated_at = excluded.updated_at, name = excluded.name, email = excluded.email,
     address = excluded.address, rooms = excluded.rooms, data = excluded.data`
);
const readDraft = db.query(`SELECT data FROM drafts WHERE id = ?`);
const deleteDraft = db.query(`DELETE FROM drafts WHERE id = ?`);
const staleDrafts = db.query(`DELETE FROM drafts WHERE updated_at < ?`);

// Added once PDFs started being kept on disk; existing databases pick it up here.
if (!(db.query(`PRAGMA table_info(checklists)`).all() as { name: string }[]).some((c) => c.name === "pdf_file")) {
  db.run(`ALTER TABLE checklists ADD COLUMN pdf_file TEXT`);
}

const insertChecklist = db.query(
  `INSERT INTO checklists (id, created_at, name, email, address, bedrooms, bathrooms, data, pdf_file)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const readChecklist = db.query(`SELECT data, pdf_file FROM checklists WHERE id = ?`);
const allChecklists = db.query(`SELECT id, data, pdf_file FROM checklists ORDER BY created_at`);
const setPdfFile = db.query(`UPDATE checklists SET pdf_file = ? WHERE id = ?`);

/**
 * Where the signed copies live. Every checklist is written here as a PDF when
 * it's signed, and that file — not the database row — is what gets served
 * afterwards: it's the artefact the tenant signed, so it shouldn't quietly
 * change if the layout in pdf.ts does. Delete a file and it is rebuilt from
 * the stored answers on the next request.
 */
const PDF_DIR = process.env.PDF_DIR ?? "pdfs";

/**
 * Sortable by name, and readable without opening it: date first, then the
 * property, the tenant, and enough of the id to keep two checklists for the
 * same flat on the same day apart.
 */
function pdfName(c: Checklist): string {
  const slug = (s: string, max: number) =>
    s.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").slice(0, max)
      .replace(/^-|-$/g, "") || "unknown";
  const day = c.signedAt.slice(0, 10);
  return `${day}_${slug(c.address, 60)}_${slug(c.name, 30)}_${c.id.slice(0, 8)}.pdf`;
}

/** Write the signed copy, returning the file name stored against the row. */
async function savePdf(c: Checklist, bytes: Uint8Array): Promise<string> {
  const file = pdfName(c);
  await Bun.write(`${PDF_DIR}/${file}`, bytes);
  return file;
}

const MAX_BODY = 4 * 1024 * 1024; // a signature PNG is a few KB; this is slack, not a target
const TEXT_MAX = 300;
const NOTES_MAX = 1000;
const ROOM_NOTES_MAX = 300; // a line about the room, not a second notes field
const GENERAL_NOTES_MAX = 4000; // the free-text section at the end of the walkthrough
const MAX_ROOMS = 40;
const MAX_ITEMS = 60;
const MAX_COUNT = 12; // bedrooms or bathrooms
const MAX_SIGNERS = 6; // besides the tenant and the agent
const CONDITION_MAX = Math.max(...CONDITIONS.map((c) => c.length));

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  // Everything this page needs is inline and same-origin; nothing is fetched.
  // blob: is for the thumbnails of photos being attached, which are drawn from
  // the file on the phone before it has finished uploading.
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; " +
    "script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

const clean = (value: unknown, max = TEXT_MAX) => String(value ?? "").trim().slice(0, max);

/** A signature is the thing that makes this a record rather than a draft. */
const isSignature = (value: string) =>
  /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) && value.length >= 200;

const count = (value: unknown) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_COUNT) : NaN;
};

/**
 * A submission, checked into the shape the PDF expects — or the reason it
 * isn't one. Everything is bounded: this endpoint takes anonymous writes, so
 * the room and item counts are what stop one POST from producing a
 * thousand-page document.
 */
async function validate(body: any): Promise<{ checklist: Omit<Checklist, "id"> } | { error: string }> {
  if (!body || typeof body !== "object") return { error: "Expected a JSON object." };

  const name = clean(body.name);
  const email = clean(body.email);
  const address = clean(body.address);
  if (!name) return { error: "A name is required." };
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "A valid email is required." };
  if (!address) return { error: "A property address is required." };

  const bedrooms = count(body.bedrooms);
  const bathrooms = count(body.bathrooms);
  if (Number.isNaN(bedrooms) || Number.isNaN(bathrooms)) {
    return { error: `Bedrooms and bathrooms must be whole numbers from 0 to ${MAX_COUNT}.` };
  }

  if (!Array.isArray(body.rooms) || body.rooms.length === 0) {
    return { error: "A checklist needs at least one room." };
  }
  if (body.rooms.length > MAX_ROOMS) return { error: `A checklist can have at most ${MAX_ROOMS} rooms.` };

  const rooms: ChecklistRoom[] = [];
  for (const room of body.rooms) {
    if (!room || typeof room !== "object") return { error: "A room was not readable." };
    const roomName = clean(room.name, 80);
    if (!roomName) return { error: "Every room needs a name." };
    if (!Array.isArray(room.items) || room.items.length === 0) {
      return { error: `“${roomName}” has no items to check.` };
    }
    if (room.items.length > MAX_ITEMS) {
      return { error: `“${roomName}” has more than ${MAX_ITEMS} items.` };
    }
    const kind: RoomKind = room.kind in ROOM_TEMPLATES ? room.kind : "other";
    rooms.push({
      kind,
      name: roomName,
      notes: clean(room.notes, ROOM_NOTES_MAX),
      items: room.items.map((item: any) => {
        // Long enough for the longest condition there is — a fixed number here
        // silently truncated "Excellent" to "Excellen", which then matched
        // nothing and stored as unanswered.
        const condition = clean(item?.condition, CONDITION_MAX);
        return {
          label: clean(item?.label, 120) || "Item",
          condition: (CONDITIONS as readonly string[]).includes(condition)
            ? (condition as Checklist["rooms"][number]["items"][number]["condition"])
            : "",
          notes: clean(item?.notes, NOTES_MAX),
        };
      }),
    });
  }

  const generalNotes = clean(body.generalNotes, GENERAL_NOTES_MAX);

  // Attachments are referred to, not carried: the files were uploaded while
  // the tenant walked round. A reference to something that isn't on disk is
  // dropped rather than printed as a missing photo.
  const attachments: Attachment[] = [];
  if (body.attachments !== undefined) {
    if (!Array.isArray(body.attachments)) return { error: "Attachments were not readable." };
    if (body.attachments.length > MAX_ATTACHMENTS) {
      return { error: `A checklist can carry at most ${MAX_ATTACHMENTS} photos and videos.` };
    }
    for (const item of body.attachments) {
      const id = String(item?.id ?? "");
      const mime = String(item?.mime ?? "");
      const path = uploadPath(id, mime);
      if (!path || !(await Bun.file(path).exists())) {
        // Skipped, not refused. This used to fail the whole submission, which
        // meant one missing photo cost a tenant the entire walkthrough — the
        // conditions they recorded matter more than an attachment that has
        // gone astray.
        console.warn(
          `[${new Date().toISOString()}] attachment ${id.slice(0, 8)} (${mime}) is not on disk; ` +
            `submitting without it`
        );
        continue;
      }
      const type = typeOf(mime)!;
      attachments.push({
        id, mime, kind: type.kind,
        name: clean(item?.name, 120) || `${type.kind}.${type.ext}`,
        size: Math.max(0, Math.round(Number(item?.size) || 0)),
      });
    }
  }

  const signature = String(body.signature ?? "");
  if (!isSignature(signature)) return { error: "A signature is required." };

  // Checked here and not only in the page: the certification is the part of
  // this document that carries any weight, so it can't be skipped by posting
  // straight at the endpoint.
  if (body.certified !== true) {
    return { error: "The certification has to be ticked before signing." };
  }

  // The agent is often not at the walkthrough, so both their name and their
  // signature are optional — but a signature that can't be attributed to
  // anyone is worse than none, so it needs the name.
  const agentName = clean(body.agentName, 120);
  const agentSignature = String(body.agentSignature ?? "");
  if (agentSignature && !agentName) {
    return { error: "Add the agent's name, or clear their signature." };
  }
  if (agentSignature && !isSignature(agentSignature)) {
    return { error: "The agent's signature didn't come through." };
  }

  /**
   * Anyone else who signed on the day. The same rules as the agent's: a mark
   * has to say whose it is, so a name and a role come with it. Bounded like
   * everything else here — a walkthrough has a handful of people at it, not a
   * hundred.
   */
  const extraSignatures: { name: string; role: string; signature: string }[] = [];
  if (body.extraSignatures !== undefined) {
    if (!Array.isArray(body.extraSignatures)) return { error: "The other signatures weren't readable." };
    if (body.extraSignatures.length > MAX_SIGNERS) {
      return { error: `At most ${MAX_SIGNERS} other people can sign here.` };
    }
    for (const entry of body.extraSignatures) {
      const who = clean(entry?.name, 120);
      const role = clean(entry?.role, 80);
      const mark = String(entry?.signature ?? "");
      if (!who) return { error: "Every other signature needs the name of who signed it." };
      if (!role) return { error: `Say what ${who} is signing as.` };
      if (!isSignature(mark)) return { error: `${who}'s signature didn't come through.` };
      extraSignatures.push({ name: who, role, signature: mark });
    }
  }

  return {
    checklist: {
      name, email, address, bedrooms, bathrooms, rooms, signature,
      generalNotes, attachments,
      certification: CERTIFICATION,
      acknowledgements: ACKNOWLEDGEMENTS,
      signedAt: new Date().toISOString(),
      ...(agentName ? { agentName } : {}),
      ...(agentSignature ? { agentSignature } : {}),
      ...(extraSignatures.length ? { extraSignatures } : {}),
    },
  };
}

/**
 * The path this app is being served under, when it isn't being served at the
 * root of its own port.
 *
 * :3100 is bound to localhost, so nobody in the office can open it — and
 * starting a move-out walkthrough from a signed report is something the office
 * does. The CRM therefore serves this page through itself, behind its sign-in,
 * under /checklist, and says so in X-Forwarded-Prefix; the page stamps the
 * prefix onto every path it asks for.
 *
 * Two segments are allowed, not one, because a link handed to a tenant carries
 * its authority in the path: the CRM serves the form at /checklist for the
 * office and at /form/<token> for somebody outside it.
 *
 * Trusted only as far as it is checked: it is written into the page, so it is
 * held to a leading slash and short runs of unremarkable characters, and
 * anything else is treated as no prefix at all. A tenant opening the form
 * directly sends no such header and gets an empty string, which is the path
 * this app has always served.
 */
function basePrefix(req: Request): string {
  const raw = (req.headers.get("X-Forwarded-Prefix") ?? "").trim().replace(/\/+$/, "");
  return /^(\/[A-Za-z0-9._~-]{1,80}){1,2}$/.test(raw) ? raw : "";
}

const page = Bun.file("public/app.html");

const ICONS: Record<string, { path: string; type: string }> = {
  "/favicon.svg": { path: "public/favicon.svg", type: "image/svg+xml" },
  "/apple-touch-icon.png": { path: "public/apple-touch-icon.png", type: "image/png" },
};

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/" && req.method === "GET") {
    if (!(await page.exists())) return new Response("app.html is missing", { status: 500 });
    // Stamped with the file's own modification time, so a report from a phone
    // says which version of this page it came from. "It does nothing" and "it
    // does nothing on a copy from three hours ago" are different problems.
    const build = new Date((await page.stat()).mtimeMs).toISOString().replace(/[-:]|\.\d+Z/g, "").slice(0, 13);
    return new Response(
      (await page.text()).replaceAll("__BUILD__", build).replaceAll("__BASE__", basePrefix(req)),
      { headers: HTML_HEADERS }
    );
  }

  /**
   * The tab icon, and the one iOS uses when the page is added to a home
   * screen. Both are the clipboard emoji — the SVG sets it as text, the PNG is
   * that same glyph rendered once, because an apple-touch-icon can't be an SVG.
   * Cached, unlike everything else here: it carries nothing about anybody.
   */
  if (ICONS[url.pathname] && req.method === "GET") {
    const icon = Bun.file(ICONS[url.pathname].path);
    if (!(await icon.exists())) return new Response("Not found", { status: 404 });
    return new Response(icon, {
      headers: { "Content-Type": ICONS[url.pathname].type, "Cache-Control": "public, max-age=86400" },
    });
  }

  // The room templates live in one place; the page asks for them rather than
  // carrying a second copy that could drift.
  if (url.pathname === "/api/templates" && req.method === "GET") {
    return Response.json(
      {
        templates: ROOM_TEMPLATES,
        conditions: CONDITIONS,
        maxCount: MAX_COUNT,
        certification: CERTIFICATION,
        acknowledgements: ACKNOWLEDGEMENTS,
        accept: acceptedTypes(),
        maxAttachments: MAX_ATTACHMENTS,
        maxPhotoBytes: MAX_PHOTO_BYTES,
        maxVideoBytes: MAX_VIDEO_BYTES,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  if (url.pathname === "/api/rooms" && req.method === "GET") {
    const bedrooms = count(url.searchParams.get("bedrooms"));
    const bathrooms = count(url.searchParams.get("bathrooms"));
    if (Number.isNaN(bedrooms) || Number.isNaN(bathrooms)) {
      return Response.json({ error: "bedrooms and bathrooms must be whole numbers" }, { status: 400 });
    }
    const furnished = url.searchParams.get("furnished") === "1";
    return Response.json(
      { rooms: defaultRooms(bedrooms, bathrooms, furnished) },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  /**
   * One photo or video, stored on its own so the walkthrough isn't held up by
   * a video finishing its upload — the tenant keeps checking rooms while it
   * goes, and the submission at the end only refers to it.
   */
  if (url.pathname === "/api/uploads" && req.method === "POST") {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_VIDEO_BYTES + 1024 * 1024) {
      return Response.json({ error: "That file is too large." }, { status: 413 });
    }

    let file: File | null = null;
    try {
      file = (await req.formData()).get("file") as File | null;
    } catch {
      return Response.json({ error: "That upload didn't arrive in one piece." }, { status: 400 });
    }
    if (!file || typeof file === "string") return Response.json({ error: "No file was sent." }, { status: 400 });

    const type = typeOf(file.type);
    if (!type) {
      return Response.json(
        { error: "Only photos (JPEG, PNG) and videos (MP4, MOV, WebM) can be attached." },
        { status: 415 }
      );
    }
    const cap = type.kind === "photo" ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES;
    if (file.size > cap) {
      return Response.json(
        { error: `That ${type.kind} is ${Math.round(file.size / 1e6)}MB — the limit is ${Math.round(cap / 1e6)}MB.` },
        { status: 413 }
      );
    }

    const id = crypto.randomUUID();
    const path = uploadPath(id, file.type)!;
    await Bun.write(path, file);
    console.log(
      `[${new Date().toISOString()}] upload ${id.slice(0, 8)} — ${type.kind}, ` +
        `${Math.round(file.size / 1024)}KB → ${path}`
    );
    return Response.json(
      {
        id, kind: type.kind, mime: file.type, size: file.size, name: clean(file.name, 120),
        // The page shows its own copy of a photo until the page goes away; the
        // URL is what a restored checklist draws the thumbnail from instead.
        url: `/uploads/${id}.${type.ext}`,
      },
      { status: 201 }
    );
  }

  // Serving an attachment back: photos are in the PDF already, but a video can
  // only ever be a link, and both are worth being able to open later.
  const upload = url.pathname.match(/^\/uploads\/([0-9a-f-]{36})\.([a-z0-9]{2,5})$/);
  if (upload && req.method === "GET") {
    const path = `${UPLOAD_DIR}/${upload[1]}.${upload[2]}`;
    const stored = Bun.file(path);
    if (!(await stored.exists())) return new Response("Not found", { status: 404 });
    return new Response(stored, {
      headers: { "Content-Type": stored.type || "application/octet-stream", "Cache-Control": "no-store, private" },
    });
  }

  /**
   * An unsigned checklist, saved as it's filled in. Addressed by an id the
   * page made up and keeps, so it updates in place rather than piling up one
   * row per keystroke, and so a checklist can be picked up again by anyone
   * holding that id — the same bargain as the PDF links.
   */
  const draft = url.pathname.match(/^\/api\/drafts\/([0-9a-f-]{36})$/);
  if (draft) {
    const id = draft[1];

    if (req.method === "GET") {
      const row = readDraft.get(id) as { data: string } | undefined;
      if (!row) return new Response("No such draft", { status: 404 });
      return new Response(row.data, {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store, private" },
      });
    }

    if (req.method === "DELETE") {
      deleteDraft.run(id); // signed, or deliberately abandoned
      return new Response(null, { status: 204 });
    }

    if (req.method === "PUT") {
      if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
        return Response.json({ error: "Too large." }, { status: 413 });
      }
      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Expected JSON." }, { status: 400 });
      }
      if (!body || typeof body !== "object") return Response.json({ error: "Expected an object." }, { status: 400 });

      // Bounded, but not held to the rules a signed checklist is held to: a
      // half-filled draft is the whole point, and refusing to keep it because
      // it isn't finished would defeat the exercise.
      const rooms = Array.isArray(body.rooms) ? body.rooms.slice(0, MAX_ROOMS) : [];
      const now = new Date().toISOString();
      const existed = Boolean(readDraft.get(id));
      const record = JSON.stringify({ ...body, rooms, signature: undefined, agentSignature: undefined });
      if (record.length > MAX_BODY) return Response.json({ error: "Too large." }, { status: 413 });

      upsertDraft.run(
        id, now, now, clean(body.name), clean(body.email), clean(body.address), rooms.length, record
      );
      if (!existed) {
        console.log(
          `[${now}] draft ${id.slice(0, 8)} started — ${clean(body.address) || "no address yet"} ` +
            `(${clean(body.name) || "unnamed"})`
        );
      }
      return Response.json({ ok: true, savedAt: now });
    }

    return new Response("Method not allowed", { status: 405 });
  }

  /**
   * A signed checklist, handed back as the starting point for another one.
   *
   * The same property gets walked twice — once when a tenant moves in and once
   * when they move out — and the second walkthrough is really the first one
   * re-checked. Typing the address, the rooms and everything recorded about
   * them a second time is how a move-out report ends up describing a slightly
   * different property from the move-in report it is meant to be compared
   * against. So this hands back what was written: the address, the agent, the
   * rooms with the condition and the note each item carried, the general
   * notes, and the photos.
   *
   * What it does not hand back is what makes a checklist a record — no
   * signature, no certification, no signing time. Those are made afresh, by
   * whoever walks the property this time.
   *
   * Behind an unguessable id, the same bargain as /checklists/:id.pdf: holding
   * the link is what gets you the checklist.
   */
  const copy = url.pathname.match(/^\/api\/checklists\/([0-9a-f-]{36})\/copy$/);
  if (copy && req.method === "GET") {
    const row = readChecklist.get(copy[1]) as { data: string } | undefined;
    if (!row) return Response.json({ error: "No such checklist." }, { status: 404 });
    const c = JSON.parse(row.data) as Checklist;
    const fresh = url.searchParams.get("fresh") === "1";

    // Photos and videos are referred to, not duplicated: both checklists point
    // at the same upload, which is why the boot-time sweep only removes a file
    // that nothing refers to. One that has gone from disk is dropped here
    // rather than arriving as a thumbnail that can't be drawn.
    const media: (Attachment & { url: string })[] = [];
    for (const a of c.attachments ?? []) {
      const type = typeOf(a.mime);
      const path = uploadPath(a.id, a.mime);
      if (!type || !path || !(await Bun.file(path).exists())) continue;
      media.push({ ...a, url: `/uploads/${a.id}.${type.ext}` });
    }

    return Response.json(
      {
        // What the page says it copied from, so nobody has to take its word
        // that the right checklist came back.
        from: { id: c.id, name: c.name, address: c.address, signedAt: c.signedAt },
        // Carried because it is usually the same tenancy — and editable,
        // which is the point when it isn't.
        name: c.name,
        email: c.email,
        address: c.address,
        bedrooms: c.bedrooms,
        bathrooms: c.bathrooms,
        // Never stored as a flag: the section either got built or it didn't.
        furnished: (c.rooms ?? []).some((r) => r.kind === "furnishings"),
        // So the page can say what it is: last time's walkthrough to correct,
        // or an empty checklist that only borrowed the property.
        fresh,
        agentName: c.agentName ?? "",
        rooms: (c.rooms ?? []).map((r) => ({
          kind: r.kind,
          name: r.name,
          notes: r.notes ?? "",
          items: (r.items ?? []).map((i) => ({
            label: i.label,
            // ?fresh=1 keeps the property and drops the answers: the rooms,
            // the items and the notes about which bedroom is which are worth
            // copying to a new tenancy; last tenant's ratings are not.
            condition: fresh ? "" : i.condition ?? "",
            notes: fresh ? "" : i.notes ?? "",
          })),
        })),
        generalNotes: fresh ? "" : c.generalNotes ?? "",
        media: fresh ? [] : media,
      },
      { headers: { "Cache-Control": "no-store, private" } }
    );
  }

  if (url.pathname === "/api/checklists" && req.method === "POST") {
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_BODY) return Response.json({ error: "That submission is too large." }, { status: 413 });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Expected JSON." }, { status: 400 });
    }

    const checked = await validate(body);
    if ("error" in checked) {
      // Logged, because a refusal the tenant can see and we can't is a
      // walkthrough that has to be done twice to find out why.
      const b = body as any;
      console.warn(
        `[${new Date().toISOString()}] REJECTED submission: ${checked.error} ` +
          `(address=${JSON.stringify(String(b?.address ?? "")).slice(0, 60)}, ` +
          `rooms=${Array.isArray(b?.rooms) ? b.rooms.length : "?"}, ` +
          `attachments=${Array.isArray(b?.attachments) ? b.attachments.length : 0}, ` +
          `certified=${b?.certified === true}, ` +
          `signature=${String(b?.signature ?? "").length}b)`
      );
      return Response.json({ error: checked.error }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const checklist: Checklist = { id, ...checked.checklist };

    // Rendered and written to disk before the row is stored: a checklist whose
    // PDF can't be produced or can't be saved is worse than one the tenant is
    // told to submit again.
    let file: string;
    try {
      file = await savePdf(checklist, await buildChecklistPdf(checklist));
    } catch (err) {
      console.error(`[${new Date().toISOString()}] could not save a checklist for ${checklist.address}`, err);
      return Response.json({ error: "That checklist could not be turned into a PDF." }, { status: 400 });
    }

    insertChecklist.run(
      id, checklist.signedAt, checklist.name, checklist.email, checklist.address,
      checklist.bedrooms, checklist.bathrooms, JSON.stringify(checklist), file
    );
    // The signed copy supersedes whatever draft it grew out of.
    const draftId = String((body as any)?.draftId ?? "");
    if (/^[0-9a-f-]{36}$/.test(draftId)) deleteDraft.run(draftId);
    console.log(
      `[${checklist.signedAt}] checklist ${id.slice(0, 8)} — ${checklist.address} ` +
        `(${checklist.rooms.length} rooms) signed by ${checklist.name} → ${PDF_DIR}/${file}`
    );
    return Response.json({ id, pdf: `/checklists/${id}.pdf` }, { status: 201 });
  }

  const pdf = url.pathname.match(/^\/checklists\/([0-9a-f-]{36})\.pdf$/);
  if (pdf && req.method === "GET") {
    const row = readChecklist.get(pdf[1]) as { data: string; pdf_file: string | null } | undefined;
    if (!row) return new Response("No such checklist", { status: 404 });
    const checklist = JSON.parse(row.data) as Checklist;

    // The copy on disk is the one that was signed, so it is what gets served.
    // Rebuilding only happens when the file has gone missing.
    let file = row.pdf_file ?? pdfName(checklist);
    const saved = Bun.file(`${PDF_DIR}/${file}`);
    let bytes: Uint8Array;
    if (await saved.exists()) {
      bytes = new Uint8Array(await saved.arrayBuffer());
    } else {
      bytes = await buildChecklistPdf(checklist);
      file = await savePdf(checklist, bytes);
      setPdfFile.run(file, checklist.id);
      console.warn(`[${new Date().toISOString()}] rebuilt a missing copy: ${PDF_DIR}/${file}`);
    }

    return new Response(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        // inline: a phone opens it in the viewer, where "share" and "save to
        // files" both live. Downloading it straight to storage hides it.
        "Content-Disposition": `inline; filename="${file}"`,
        "Cache-Control": "no-store, private",
      },
    });
  }

  /**
   * Errors from the page itself. Everything else here is debugged from the
   * server's own logs, but a button that "does nothing" fails in someone
   * else's browser, on a phone that isn't here — and until this existed the
   * only evidence was a person saying nothing happened.
   */
  if (url.pathname === "/api/client-error" && req.method === "POST") {
    let report: any = {};
    try {
      report = await req.json();
    } catch {
      /* logged as far as it got */
    }
    console.error(
      `[${new Date().toISOString()}] CLIENT ERROR build=${clean(report?.build, 40) || "?"} ` +
        `step=${clean(report?.step, 8)} where=${clean(report?.where, 40)}\n` +
        `    ${clean(report?.message, 300)}\n` +
        `    ${clean(report?.stack, 600).replace(/\n/g, "\n    ")}\n` +
        `    ua=${clean(req.headers.get("user-agent"), 200)}`
    );
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/api/health") return Response.json({ ok: true });

  return new Response("Not found", { status: 404 });
}

/**
 * Every checklist ever signed should have a file on disk, including the ones
 * submitted before this app kept them. Run at boot: it writes what's missing
 * and leaves alone what isn't, so it costs nothing on the usual start.
 */
async function backfillPdfs() {
  const rows = allChecklists.all() as { id: string; data: string; pdf_file: string | null }[];
  let written = 0;
  for (const row of rows) {
    try {
      const checklist = JSON.parse(row.data) as Checklist;
      const file = row.pdf_file ?? pdfName(checklist);
      if (await Bun.file(`${PDF_DIR}/${file}`).exists()) {
        if (!row.pdf_file) setPdfFile.run(file, row.id); // on disk, just unrecorded
        continue;
      }
      setPdfFile.run(await savePdf(checklist, await buildChecklistPdf(checklist)), row.id);
      written++;
    } catch (err) {
      // One unreadable row shouldn't stop the rest from being written.
      console.error(`[${new Date().toISOString()}] could not back-fill ${row.id.slice(0, 8)}`, err);
    }
  }
  console.log(
    written
      ? `Saved ${written} missing ${written === 1 ? "copy" : "copies"} to ${PDF_DIR}/ (${rows.length} checklists on file)`
      : `All ${rows.length} checklists have a saved copy in ${PDF_DIR}/`
  );
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3100),
  hostname: process.env.HOST ?? "127.0.0.1",
  async fetch(req) {
    try {
      return await handle(req);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] unhandled`, err);
      return new Response("Something went wrong", { status: 500 });
    }
  },
});

console.log(`Checklists on http://${server.hostname}:${server.port}`);

// After the port is open, so a large back-fill can't delay taking requests.
backfillPdfs()
  .then(async () => {
    // Photos and videos from walkthroughs that were never signed off. Only
    // files older than a day go, so one still sitting in a form on someone's
    // phone is safe.
    const referenced = new Set<string>();
    for (const row of allChecklists.all() as { data: string }[]) {
      for (const a of (JSON.parse(row.data) as Checklist).attachments ?? []) referenced.add(a.id);
    }
    const removed = await sweepOrphans(referenced);
    if (removed) console.log(`Swept ${removed} unused upload${removed === 1 ? "" : "s"} from ${UPLOAD_DIR}/`);

    // Drafts nobody came back to. Well past the week the browser keeps its own
    // copy, so this can't be what takes an in-progress checklist away.
    const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const gone = staleDrafts.run(cutoff).changes;
    if (gone) console.log(`Removed ${gone} draft${gone === 1 ? "" : "s"} untouched for 60 days`);

    const open = (db.query(`SELECT COUNT(*) AS n FROM drafts`).get() as { n: number }).n;
    if (open) console.log(`${open} unsigned draft${open === 1 ? "" : "s"} on file`);
  })
  .catch((err) => console.error("start-up housekeeping failed", err));
