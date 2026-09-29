/**
 * The submitted application, as one PDF: the answers, the notice and the
 * signature, then every attached document after them — photos a page each and
 * uploaded PDFs page for page — so the office reviews a single file.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { uploadPath } from "./uploads";
import type { Application } from "./types";

const PAGE = { w: 612, h: 792 }; // US Letter, in points
const MARGIN = 50;
const CONTENT_W = PAGE.w - MARGIN * 2;
const LABEL_W = 150;

const INK = rgb(0.1, 0.11, 0.12);
const MUTED = rgb(0.42, 0.45, 0.49);
const RULE = rgb(0.85, 0.87, 0.89);

/** The standard fonts are WinAnsi-only, and pdf-lib throws on anything else. */
function winAnsi(text: string): string {
  return String(text ?? "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, "");
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const para of winAnsi(text).split(/\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let line = words[0];
    for (const word of words.slice(1)) {
      const candidate = `${line} ${word}`;
      if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
      else { lines.push(line); line = word; }
    }
    lines.push(line);
  }
  return lines;
}

type Ctx = { doc: PDFDocument; page: PDFPage; y: number; regular: PDFFont; bold: PDFFont };

function newPage(ctx: Ctx) {
  ctx.page = ctx.doc.addPage([PAGE.w, PAGE.h]);
  ctx.y = PAGE.h - MARGIN;
}

function ensure(ctx: Ctx, needed: number) {
  if (ctx.y - needed < MARGIN) newPage(ctx);
}

function heading(ctx: Ctx, title: string) {
  ensure(ctx, 48);
  ctx.y -= 14;
  ctx.page.drawText(winAnsi(title), { x: MARGIN, y: ctx.y, size: 12, font: ctx.bold, color: INK });
  ctx.y -= 6;
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y }, end: { x: PAGE.w - MARGIN, y: ctx.y }, thickness: 0.8, color: RULE,
  });
  ctx.y -= 14;
}

/** A label on the left and its answer wrapped beside it; a blank prints as a dash. */
function row(ctx: Ctx, label: string, value: string) {
  const lines = wrap(value || "-", ctx.regular, 10, CONTENT_W - LABEL_W);
  ensure(ctx, lines.length * 13 + 4);
  ctx.page.drawText(winAnsi(label), { x: MARGIN, y: ctx.y, size: 9, font: ctx.regular, color: MUTED });
  for (const line of lines) {
    ctx.page.drawText(line, { x: MARGIN + LABEL_W, y: ctx.y, size: 10, font: ctx.regular, color: INK });
    ctx.y -= 13;
  }
  ctx.y -= 3;
}

function paragraph(ctx: Ctx, value: string, size = 9, color = INK) {
  for (const line of wrap(value, ctx.regular, size, CONTENT_W)) {
    ensure(ctx, size + 4);
    ctx.page.drawText(line, { x: MARGIN, y: ctx.y, size, font: ctx.regular, color });
    ctx.y -= size + 3.5;
  }
  ctx.y -= 4;
}

function subheading(ctx: Ctx, title: string) {
  ensure(ctx, 30);
  ctx.y -= 2;
  ctx.page.drawText(winAnsi(title), { x: MARGIN, y: ctx.y, size: 10, font: ctx.bold, color: INK });
  ctx.y -= 15;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", dateStyle: "long", timeStyle: "short",
  }) + " Pacific";

export async function buildApplicationPdf(a: Application): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const ctx: Ctx = {
    doc, page: null as unknown as PDFPage, y: 0,
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  newPage(ctx);
  doc.setTitle(`Rental application - ${winAnsi(a.name)} - ${winAnsi(a.property)}`);
  doc.setCreationDate(new Date(a.submittedAt));

  ctx.page.drawText("Rental Application", { x: MARGIN, y: ctx.y - 6, size: 20, font: ctx.bold, color: INK });
  ctx.y -= 26;
  ctx.page.drawText(winAnsi(`${a.property} - submitted ${when(a.submittedAt)}`), {
    x: MARGIN, y: ctx.y, size: 10, font: ctx.regular, color: MUTED,
  });
  ctx.y -= 10;

  heading(ctx, "Applicant");
  row(ctx, "Full name", a.name);
  row(ctx, "Email", a.email);
  row(ctx, "Phone", a.phone);
  row(ctx, "Date of birth", a.dob);

  heading(ctx, "The home");
  row(ctx, "Property", a.property);
  row(ctx, "Desired move-in", a.moveIn);
  row(ctx, "Lease term", a.leaseTerm);

  heading(ctx, "Residence history");
  a.residences.forEach((r, i) => {
    subheading(ctx, i === 0 ? "Current residence" : `Previous residence ${i}`);
    row(ctx, "Address", r.address);
    row(ctx, "Dates", `${r.from || "?"} to ${r.to || (i === 0 ? "present" : "?")}`);
    row(ctx, "Monthly rent", r.rent);
    row(ctx, "Landlord", [r.landlordName, r.landlordPhone].filter(Boolean).join(", "));
    row(ctx, "Reason for leaving", r.reason);
  });

  heading(ctx, "Employment and income");
  if (!a.jobs.length) paragraph(ctx, "No employment listed.", 9, MUTED);
  a.jobs.forEach((j, i) => {
    subheading(ctx, a.jobs.length > 1 ? `Employer ${i + 1}` : "Employer");
    row(ctx, "Employer", j.employer);
    row(ctx, "Position", j.position);
    row(ctx, "Since", j.from);
    row(ctx, "Gross monthly income", j.monthlyIncome);
    row(ctx, "Contact", [j.contactName, j.contactPhone].filter(Boolean).join(", "));
  });
  row(ctx, "Other income", a.otherIncome);

  heading(ctx, "Household");
  row(
    ctx, "Other occupants",
    a.occupants.length
      ? a.occupants.map((o) => `${o.name}${o.relationship ? ` (${o.relationship})` : ""}${o.adult ? ", 18+" : ""}`).join("; ")
      : "None"
  );
  row(ctx, "Pets", a.pets || "None");
  row(
    ctx, "Vehicles",
    a.vehicles.length
      ? a.vehicles.map((v) => [v.color, v.make, v.model].filter(Boolean).join(" ") +
          (v.plate ? `, plate ${v.plate}${v.state ? ` (${v.state})` : ""}` : "")).join("; ")
      : "None"
  );
  row(ctx, "Emergency contact",
    [a.emergencyName, a.emergencyRelationship, a.emergencyPhone].filter(Boolean).join(", "));
  if (a.notes) row(ctx, "Anything else", a.notes);
  row(ctx, "Documents attached",
    a.attachments.length ? a.attachments.map((f) => f.name).join("; ") : "None");

  heading(ctx, "Screening notice");
  paragraph(ctx, a.screeningNotice);
  heading(ctx, "Acknowledgements");
  for (const line of a.acknowledgements) paragraph(ctx, `- ${line}`);

  heading(ctx, "Certification and signature");
  paragraph(ctx, `[x] ${a.certification}`, 9.5);
  ensure(ctx, 110);
  const png = await doc.embedPng(a.signature);
  const scale = Math.min(220 / png.width, 70 / png.height);
  ctx.y -= png.height * scale;
  ctx.page.drawImage(png, { x: MARGIN, y: ctx.y, width: png.width * scale, height: png.height * scale });
  ctx.y -= 4;
  ctx.page.drawLine({ start: { x: MARGIN, y: ctx.y }, end: { x: MARGIN + 240, y: ctx.y }, thickness: 0.8, color: INK });
  ctx.y -= 12;
  ctx.page.drawText(winAnsi(`${a.name} - signed electronically ${when(a.submittedAt)}`), {
    x: MARGIN, y: ctx.y, size: 8.5, font: ctx.regular, color: MUTED,
  });

  // The documents, after the application itself. One that can't be read — a
  // password-protected PDF, a file gone from disk — is named on a page of its
  // own rather than failing the whole packet.
  for (const file of a.attachments) {
    const path = uploadPath(file.id, file.mime);
    const bytes = path && (await Bun.file(path).exists()) ? new Uint8Array(await Bun.file(path).arrayBuffer()) : null;
    try {
      if (!bytes) throw new Error("missing");
      if (file.kind === "pdf") {
        const src = await PDFDocument.load(bytes);
        for (const p of await doc.copyPages(src, src.getPageIndices())) doc.addPage(p);
        continue;
      }
      const img = file.mime === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      newPage(ctx);
      ctx.page.drawText(winAnsi(`Attached: ${file.name}`), { x: MARGIN, y: ctx.y, size: 9, font: ctx.regular, color: MUTED });
      const room = { w: CONTENT_W, h: PAGE.h - MARGIN * 2 - 20 };
      const s = Math.min(room.w / img.width, room.h / img.height, 1);
      ctx.page.drawImage(img, {
        x: MARGIN + (room.w - img.width * s) / 2, y: MARGIN + (room.h - img.height * s),
        width: img.width * s, height: img.height * s,
      });
    } catch {
      newPage(ctx);
      paragraph(ctx, `Attached: ${file.name} - this file could not be included here; it is kept alongside the application.`, 10, MUTED);
    }
  }

  return doc.save();
}
