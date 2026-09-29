/**
 * Rental applications — somebody interested in a home fills one in on their
 * phone, attaches their documents, signs, and the office gets a single PDF.
 *
 * Separate from the CRM on :3000 for the same reason the checklist app is: this
 * is a page handed to the public, so it carries no tenant list, no door codes
 * and no sign-in. It binds to localhost, and the public reaches it through the
 * CRM at /apply, which passes on only the paths this form uses (see
 * applications.ts in the CRM). The office reads what comes in on the CRM's
 * Applications tab, which opens this app's database read-only.
 */
import { Database } from "bun:sqlite";
import { ACKNOWLEDGEMENTS, CERTIFICATION, SCREENING_NOTICE } from "./legal";
import { buildApplicationPdf } from "./pdf";
import {
  MAX_ATTACHMENTS, MAX_FILE_BYTES, UPLOAD_DIR,
  acceptedTypes, sweepOrphans, typeOf, uploadPath, type Attachment,
} from "./uploads";
import type { Application, Job, Occupant, Residence, Vehicle } from "./types";

const db = new Database(process.env.DB_PATH ?? "applications.db");
db.run("PRAGMA journal_mode = WAL");
db.run(`
  CREATE TABLE IF NOT EXISTS applications (
    id            TEXT PRIMARY KEY,
    submitted_at  TEXT NOT NULL,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL,
    phone         TEXT NOT NULL,
    property      TEXT NOT NULL,
    move_in       TEXT NOT NULL,
    -- The applicant's own link to their copy. Separate from the id, which
    -- the office's links use, so neither can be worked out from the other.
    receipt       TEXT NOT NULL UNIQUE,
    pdf_file      TEXT,
    -- The whole submission, so the PDF can be rebuilt if the file goes.
    data          TEXT NOT NULL
  )
`);

const insertApplication = db.query(
  `INSERT INTO applications (id, submitted_at, name, email, phone, property, move_in, receipt, pdf_file, data)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const byReceipt = db.query(`SELECT id, data, pdf_file FROM applications WHERE receipt = ?`);
const byId = db.query(`SELECT id, data, pdf_file FROM applications WHERE id = ?`);
const allApplications = db.query(`SELECT id, data, pdf_file FROM applications`);
const setPdfFile = db.query(`UPDATE applications SET pdf_file = ? WHERE id = ?`);

/**
 * The PDF on disk is the copy that was signed, and it is what gets served. It
 * is rebuilt from the stored answers only when the file has gone missing.
 */
const PDF_DIR = process.env.PDF_DIR ?? "pdfs";

function pdfName(a: Application): string {
  const slug = (s: string, max: number) =>
    s.normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").slice(0, max)
      .replace(/^-|-$/g, "") || "unknown";
  return `${a.submittedAt.slice(0, 10)}_${slug(a.property, 50)}_${slug(a.name, 30)}_${a.id.slice(0, 8)}.pdf`;
}

async function pdfFor(row: { id: string; data: string; pdf_file: string | null }): Promise<Uint8Array> {
  const app = JSON.parse(row.data) as Application;
  const file = row.pdf_file ?? pdfName(app);
  const saved = Bun.file(`${PDF_DIR}/${file}`);
  if (await saved.exists()) return new Uint8Array(await saved.arrayBuffer());
  const bytes = await buildApplicationPdf(app);
  await Bun.write(`${PDF_DIR}/${file}`, bytes);
  setPdfFile.run(file, row.id);
  return bytes;
}

/**
 * Anyone on the internet can post here, through the CRM, and the CRM sees every
 * visitor arrive from the same tunnel — so these are caps on the app as a
 * whole rather than per person. Far above what a leasing season produces, and
 * low enough that a script can't fill the disk overnight.
 */
const LIMITS = { application: { max: 60, windowMs: 60 * 60 * 1000 }, upload: { max: 600, windowMs: 60 * 60 * 1000 } };
const recent: Record<keyof typeof LIMITS, number[]> = { application: [], upload: [] };
function overLimit(kind: keyof typeof LIMITS): boolean {
  const now = Date.now();
  const list = (recent[kind] = recent[kind].filter((t) => now - t < LIMITS[kind].windowMs));
  if (list.length >= LIMITS[kind].max) return true;
  list.push(now);
  return false;
}

const MAX_BODY = 2 * 1024 * 1024; // a signature PNG is a few KB; this is slack
const TEXT_MAX = 200;
const LONG_MAX = 2000;
const MAX_RESIDENCES = 3;
const MAX_JOBS = 3;
const MAX_OCCUPANTS = 10;
const MAX_VEHICLES = 4;
const LEASE_TERMS = ["12 months", "6 months", "Month to month", "Other"];

const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; " +
    "script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

const clean = (value: unknown, max = TEXT_MAX) => String(value ?? "").trim().slice(0, max);
const list = (value: unknown, max: number) => (Array.isArray(value) ? value.slice(0, max) : []);
const isSignature = (value: string) =>
  /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) && value.length >= 200;
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

/** A submission checked into the shape the PDF expects, or the reason it isn't one. */
async function validate(b: any): Promise<{ application: Omit<Application, "id" | "submittedAt"> } | { error: string }> {
  if (!b || typeof b !== "object") return { error: "Expected a JSON object." };

  const property = clean(b.property);
  const name = clean(b.name);
  const email = clean(b.email);
  const phone = clean(b.phone, 40);
  const dob = clean(b.dob, 10);
  const moveIn = clean(b.moveIn, 10);
  if (!property) return { error: "Say which home you are applying for." };
  if (!name) return { error: "Your full name is required." };
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "A valid email is required." };
  if (phone.replace(/\D/g, "").length < 7) return { error: "A phone number is required." };
  if (!isDate(dob)) return { error: "Your date of birth is required." };
  if (!isDate(moveIn)) return { error: "A move-in date is required." };

  const residences: Residence[] = list(b.residences, MAX_RESIDENCES).map((r: any) => ({
    address: clean(r?.address), from: clean(r?.from, 7), to: clean(r?.to, 7), rent: clean(r?.rent, 40),
    landlordName: clean(r?.landlordName), landlordPhone: clean(r?.landlordPhone, 40), reason: clean(r?.reason, 400),
  }));
  if (!residences[0]?.address) return { error: "Your current address is required." };

  const jobs: Job[] = list(b.jobs, MAX_JOBS)
    .map((j: any) => ({
      employer: clean(j?.employer), position: clean(j?.position), from: clean(j?.from, 7),
      monthlyIncome: clean(j?.monthlyIncome, 40), contactName: clean(j?.contactName), contactPhone: clean(j?.contactPhone, 40),
    }))
    .filter((j: Job) => j.employer);

  const occupants: Occupant[] = list(b.occupants, MAX_OCCUPANTS)
    .map((o: any) => ({ name: clean(o?.name), relationship: clean(o?.relationship, 60), adult: o?.adult === true }))
    .filter((o: Occupant) => o.name);
  const vehicles: Vehicle[] = list(b.vehicles, MAX_VEHICLES)
    .map((v: any) => ({
      make: clean(v?.make, 40), model: clean(v?.model, 40), color: clean(v?.color, 30),
      plate: clean(v?.plate, 12).toUpperCase(), state: clean(v?.state, 2).toUpperCase(),
    }))
    .filter((v: Vehicle) => v.make || v.model || v.plate);

  // Referred to, not carried: the files were uploaded while the form was
  // filled in. One that isn't on disk is dropped rather than costing the
  // applicant the whole submission.
  const attachments: Attachment[] = [];
  for (const item of list(b.attachments, MAX_ATTACHMENTS)) {
    const id = String(item?.id ?? "");
    const mime = String(item?.mime ?? "");
    const path = uploadPath(id, mime);
    if (!path || !(await Bun.file(path).exists())) {
      console.warn(`[${new Date().toISOString()}] attachment ${id.slice(0, 8)} is not on disk; submitting without it`);
      continue;
    }
    const type = typeOf(mime)!;
    attachments.push({
      id, mime, kind: type.kind, name: clean(item?.name, 120) || `document.${type.ext}`,
      size: Math.max(0, Math.round(Number(item?.size) || 0)),
    });
  }

  if (b.screeningAcknowledged !== true) return { error: "Please confirm you have read the screening notice." };
  if (b.certified !== true) return { error: "Please tick the certification before signing." };
  const signature = String(b.signature ?? "");
  if (!isSignature(signature)) return { error: "Please sign the application." };

  const leaseTerm = clean(b.leaseTerm, 40);
  return {
    application: {
      property, moveIn, name, email, phone, dob,
      leaseTerm: LEASE_TERMS.includes(leaseTerm) ? leaseTerm : "Other",
      residences, jobs, otherIncome: clean(b.otherIncome, 400),
      occupants, pets: clean(b.pets, 400), vehicles,
      emergencyName: clean(b.emergencyName), emergencyPhone: clean(b.emergencyPhone, 40),
      emergencyRelationship: clean(b.emergencyRelationship, 60),
      notes: clean(b.notes, LONG_MAX), attachments, signature,
      certification: CERTIFICATION, screeningNotice: SCREENING_NOTICE, acknowledgements: ACKNOWLEDGEMENTS,
    },
  };
}

/**
 * The path this app is served under. The CRM serves it at /apply and says so
 * in X-Forwarded-Prefix; it is written into the page, so it is held to one
 * short, plain segment or ignored.
 */
function basePrefix(req: Request): string {
  const raw = (req.headers.get("X-Forwarded-Prefix") ?? "").trim().replace(/\/+$/, "");
  return /^\/[A-Za-z0-9._~-]{1,40}$/.test(raw) ? raw : "";
}

const page = Bun.file("public/app.html");
const ICONS: Record<string, { path: string; type: string }> = {
  "/favicon.svg": { path: "public/favicon.svg", type: "image/svg+xml" },
};

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/" && req.method === "GET") {
    if (!(await page.exists())) return new Response("app.html is missing", { status: 500 });
    const build = new Date((await page.stat()).mtimeMs).toISOString().replace(/[-:]|\.\d+Z/g, "").slice(0, 13);
    return new Response(
      (await page.text()).replaceAll("__BUILD__", build).replaceAll("__BASE__", basePrefix(req)),
      { headers: HTML_HEADERS }
    );
  }

  if (ICONS[url.pathname] && req.method === "GET") {
    const icon = Bun.file(ICONS[url.pathname].path);
    if (!(await icon.exists())) return new Response("Not found", { status: 404 });
    return new Response(icon, {
      headers: { "Content-Type": ICONS[url.pathname].type, "Cache-Control": "public, max-age=86400" },
    });
  }

  // The wording lives in legal.ts; the page asks for it rather than keeping a
  // second copy that could drift from what gets stored.
  if (url.pathname === "/api/terms" && req.method === "GET") {
    return Response.json(
      {
        screeningNotice: SCREENING_NOTICE, certification: CERTIFICATION, acknowledgements: ACKNOWLEDGEMENTS,
        leaseTerms: LEASE_TERMS, accepted: acceptedTypes(), maxFileBytes: MAX_FILE_BYTES,
        maxAttachments: MAX_ATTACHMENTS,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  if (url.pathname === "/api/uploads" && req.method === "POST") {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_FILE_BYTES + 1024 * 1024) {
      return Response.json({ error: "That file is too large." }, { status: 413 });
    }
    if (overLimit("upload")) {
      return Response.json({ error: "Too many uploads right now — try again in a little while." }, { status: 429 });
    }
    let file: File | null = null;
    try {
      file = (await req.formData()).get("file") as File | null;
    } catch {
      return Response.json({ error: "That upload didn't arrive in one piece." }, { status: 400 });
    }
    if (!file || typeof file === "string") return Response.json({ error: "No file was sent." }, { status: 400 });
    const type = typeOf(file.type);
    if (!type) return Response.json({ error: "Only photos (JPEG, PNG) and PDFs can be attached." }, { status: 415 });
    if (file.size > MAX_FILE_BYTES) {
      return Response.json(
        { error: `That file is ${Math.round(file.size / 1e6)}MB — the limit is ${Math.round(MAX_FILE_BYTES / 1e6)}MB.` },
        { status: 413 }
      );
    }
    const id = crypto.randomUUID();
    const path = uploadPath(id, file.type)!;
    await Bun.write(path, file);
    console.log(`[${new Date().toISOString()}] upload ${id.slice(0, 8)} — ${type.kind}, ${Math.round(file.size / 1024)}KB`);
    return Response.json(
      { id, kind: type.kind, mime: file.type, size: file.size, name: clean(file.name, 120) },
      { status: 201 }
    );
  }

  if (url.pathname === "/api/applications" && req.method === "POST") {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) {
      return Response.json({ error: "That submission is too large." }, { status: 413 });
    }
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: "Expected JSON." }, { status: 400 });
    }
    const checked = await validate(body);
    if ("error" in checked) {
      console.warn(`[${new Date().toISOString()}] REJECTED application: ${checked.error}`);
      return Response.json({ error: checked.error }, { status: 400 });
    }
    if (overLimit("application")) {
      return Response.json({ error: "We're receiving a lot of applications — try again in a little while." }, { status: 429 });
    }

    const application: Application = { id: crypto.randomUUID(), submittedAt: new Date().toISOString(), ...checked.application };
    // Written to disk before the row is stored: an application whose PDF
    // can't be produced is better refused than half-kept.
    let file: string;
    try {
      file = pdfName(application);
      await Bun.write(`${PDF_DIR}/${file}`, await buildApplicationPdf(application));
    } catch (err) {
      console.error(`[${new Date().toISOString()}] could not build the PDF for an application`, err);
      return Response.json({ error: "That application could not be saved — please try again." }, { status: 500 });
    }
    const receipt = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    insertApplication.run(
      application.id, application.submittedAt, application.name, application.email, application.phone,
      application.property, application.moveIn, receipt, file, JSON.stringify(application)
    );
    console.log(
      `[${application.submittedAt}] application ${application.id.slice(0, 8)} — ${application.property} ` +
        `(${application.attachments.length} documents) → ${PDF_DIR}/${file}`
    );
    return Response.json({ receipt, pdf: `/copy/${receipt}.pdf` }, { status: 201 });
  }

  // The applicant's own copy, on the link they were handed when they submitted.
  const copy = url.pathname.match(/^\/copy\/([0-9a-f]{64})\.pdf$/);
  if (copy && req.method === "GET") {
    const row = byReceipt.get(copy[1]) as { id: string; data: string; pdf_file: string | null } | undefined;
    if (!row) return new Response("Not found", { status: 404 });
    return new Response(await pdfFor(row), {
      headers: {
        "Content-Type": "application/pdf", "Cache-Control": "no-store, private",
        "Content-Disposition": `inline; filename="rental-application.pdf"`,
      },
    });
  }

  // The office's copy, by id — reached only from the CRM, behind its sign-in.
  const office = url.pathname.match(/^\/applications\/([0-9a-f-]{36})\.pdf$/);
  if (office && req.method === "GET") {
    const row = byId.get(office[1]) as { id: string; data: string; pdf_file: string | null } | undefined;
    if (!row) return new Response("Not found", { status: 404 });
    return new Response(await pdfFor(row), {
      headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store, private" },
    });
  }

  if (url.pathname === "/api/client-error" && req.method === "POST") {
    const text = clean(await req.text().catch(() => ""), 1000);
    console.warn(`[${new Date().toISOString()}] client error: ${text}`);
    return new Response(null, { status: 204 });
  }

  if (url.pathname === "/api/health") return Response.json({ ok: true });

  return new Response("Not found", { status: 404 });
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3200),
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

console.log(`Applications on http://${server.hostname}:${server.port}`);

// Documents from applications that were never submitted.
// Skipped entirely if any row can't be read: its files can't be told apart from
// abandoned ones, and deleting somebody's ID by mistake is the worse outcome.
const referenced = new Set<string>();
let readable = true;
for (const row of allApplications.all() as { data: string }[]) {
  try {
    for (const a of (JSON.parse(row.data) as Application).attachments) referenced.add(a.id);
  } catch {
    readable = false;
  }
}
if (readable) {
  sweepOrphans(referenced).then((n) => n && console.log(`Removed ${n} unused upload${n === 1 ? "" : "s"} from ${UPLOAD_DIR}/`));
}
