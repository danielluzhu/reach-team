/**
 * The signed checklist, as a PDF.
 *
 * Laid out by hand rather than from HTML: this is the copy a tenant and a
 * landlord both keep, so it has to paginate predictably and carry the same
 * wording every time, which a print stylesheet across phone browsers does not.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { uploadPath, type Attachment } from "./uploads";
import type { Checklist } from "./types";

/**
 * A stored photo, or nothing if it has gone missing. A checklist whose photo
 * was deleted off the disk should still produce its PDF — the record of the
 * conditions is the part that matters.
 */
async function loadAttachment(a: Attachment): Promise<Uint8Array | null> {
  const path = uploadPath(a.id, a.mime);
  if (!path) return null;
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return new Uint8Array(await file.arrayBuffer());
}

const PAGE = { w: 595.28, h: 841.89 }; // A4 portrait, in points
const MARGIN = 48;
const CONTENT_W = PAGE.w - MARGIN * 2;

const INK = rgb(0.1, 0.11, 0.12);
const MUTED = rgb(0.42, 0.45, 0.49);
const RULE = rgb(0.85, 0.87, 0.89);
const BAND = rgb(0.95, 0.96, 0.97);

/** Column geometry for the item rows: item, condition, notes. */
const COL_ITEM = MARGIN;
const COL_COND = MARGIN + 190;
const COL_NOTE = MARGIN + 258;
const NOTE_W = PAGE.w - MARGIN - COL_NOTE;

/**
 * The standard fonts are WinAnsi-encoded, and pdf-lib throws rather than
 * dropping a character it can't encode — so a curly quote pasted out of a
 * phone keyboard would fail the whole document. Fold what has an obvious
 * equivalent, drop what doesn't.
 */
function winAnsi(text: string): string {
  return String(text ?? "")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/[^\x20-\x7E\xA1-\xFF]/g, "");
}

/** Greedy wrap to a pixel width, measured in the font it will be drawn in. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = winAnsi(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
    else { lines.push(line); line = word; }
  }
  lines.push(line);
  return lines;
}

type Ctx = {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  regular: PDFFont;
  bold: PDFFont;
  pages: PDFPage[];
};

function newPage(ctx: Ctx) {
  ctx.page = ctx.doc.addPage([PAGE.w, PAGE.h]);
  ctx.pages.push(ctx.page);
  ctx.y = PAGE.h - MARGIN;
}

/** Start a new page when `needed` points wouldn't fit above the bottom margin. */
function ensure(ctx: Ctx, needed: number) {
  if (ctx.y - needed < MARGIN + 28) newPage(ctx);
}

function text(ctx: Ctx, s: string, x: number, size: number, font: PDFFont, color = INK) {
  ctx.page.drawText(winAnsi(s), { x, y: ctx.y, size, font, color });
}

export async function buildChecklistPdf(c: Checklist): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = { doc, page: null as unknown as PDFPage, y: 0, regular, bold, pages: [] };
  newPage(ctx);

  doc.setTitle(`Property condition checklist - ${winAnsi(c.address)}`);
  doc.setSubject("Move-in property condition checklist");
  doc.setCreationDate(new Date(c.signedAt));

  // ---- heading -------------------------------------------------------------
  ctx.y -= 6;
  text(ctx, "Property Condition Checklist", MARGIN, 19, bold);
  ctx.y -= 18;
  text(ctx, c.address, MARGIN, 11, regular, MUTED);
  ctx.y -= 20;
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y }, end: { x: PAGE.w - MARGIN, y: ctx.y },
    thickness: 1, color: RULE,
  });
  ctx.y -= 22;

  // ---- who and what --------------------------------------------------------
  const facts: [string, string][] = [
    ["Tenant", c.name],
    ["Email", c.email],
    ["Property", c.address],
    ["Bedrooms", String(c.bedrooms)],
    ["Bathrooms", String(c.bathrooms)],
    ["Completed", new Date(c.signedAt).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })],
  ];
  for (const [label, value] of facts) {
    ensure(ctx, 16);
    text(ctx, label, MARGIN, 9.5, bold, MUTED);
    for (const [i, line] of wrap(value, regular, 10.5, CONTENT_W - 110).entries()) {
      if (i > 0) ctx.y -= 13;
      text(ctx, line, MARGIN + 110, 10.5, regular);
    }
    ctx.y -= 17;
  }

  // ---- rooms ---------------------------------------------------------------
  for (const room of c.rooms) {
    ensure(ctx, 76); // a heading alone at the foot of a page reads as an error
    ctx.y -= 10;
    ctx.page.drawRectangle({
      x: MARGIN - 6, y: ctx.y - 5, width: CONTENT_W + 12, height: 21, color: BAND,
    });
    text(ctx, room.name, MARGIN, 12, bold);
    ctx.y -= 24;

    // What the room is, before what's in it — "Bedroom 2" on its own tells a
    // reader nothing months later.
    if (room.notes) {
      for (const line of wrap(room.notes, regular, 9, CONTENT_W)) {
        ensure(ctx, 13);
        text(ctx, line, MARGIN, 9, regular, MUTED);
        ctx.y -= 12;
      }
      ctx.y -= 4;
    }

    text(ctx, "ITEM", COL_ITEM, 7.5, bold, MUTED);
    text(ctx, "CONDITION", COL_COND, 7.5, bold, MUTED);
    text(ctx, "NOTES", COL_NOTE, 7.5, bold, MUTED);
    ctx.y -= 6;
    ctx.page.drawLine({
      start: { x: MARGIN, y: ctx.y }, end: { x: PAGE.w - MARGIN, y: ctx.y },
      thickness: 0.75, color: RULE,
    });
    ctx.y -= 15;

    for (const item of room.items) {
      const noteLines = wrap(item.notes ?? "", regular, 9, NOTE_W);
      const nameLines = wrap(item.label, regular, 9.5, COL_COND - COL_ITEM - 12);
      const rows = Math.max(1, noteLines.length, nameLines.length);
      ensure(ctx, rows * 12 + 8);

      const top = ctx.y;
      nameLines.forEach((line, i) => {
        ctx.y = top - i * 12;
        text(ctx, line, COL_ITEM, 9.5, regular);
      });
      ctx.y = top;
      // An unanswered item prints as a dash rather than blank, so a skipped
      // line can't be mistaken for one the printer dropped.
      const condition = item.condition || "—";
      text(ctx, condition === "—" ? "-" : condition, COL_COND, 9.5,
        item.condition === "Poor" ? bold : regular,
        item.condition === "Poor" ? rgb(0.65, 0.11, 0.11) : INK);
      noteLines.forEach((line, i) => {
        ctx.y = top - i * 12;
        text(ctx, line, COL_NOTE, 9, regular, MUTED);
      });

      ctx.y = top - rows * 12 - 3;
      ctx.page.drawLine({
        start: { x: MARGIN, y: ctx.y + 6 }, end: { x: PAGE.w - MARGIN, y: ctx.y + 6 },
        thickness: 0.4, color: RULE,
      });
      ctx.y -= 6;
    }
  }

  // ---- notes that didn't belong to a room ----------------------------------
  if (c.generalNotes) {
    ensure(ctx, 70);
    ctx.y -= 10;
    ctx.page.drawRectangle({
      x: MARGIN - 6, y: ctx.y - 5, width: CONTENT_W + 12, height: 21, color: BAND,
    });
    text(ctx, "Additional notes", MARGIN, 12, bold);
    ctx.y -= 26;
    // Blank lines are kept: someone who wrote a list meant it to read as one.
    for (const paragraph of c.generalNotes.split(/\n/)) {
      const lines = paragraph.trim() ? wrap(paragraph, regular, 9.5, CONTENT_W) : [""];
      for (const line of lines) {
        ensure(ctx, 14);
        if (line) text(ctx, line, MARGIN, 9.5, regular);
        ctx.y -= 13;
      }
    }
    ctx.y -= 4;
  }

  // ---- photos and videos ---------------------------------------------------
  const attachments = c.attachments ?? [];
  if (attachments.length) {
    const photos = attachments.filter((a) => a.kind === "photo");
    const videos = attachments.filter((a) => a.kind === "video");

    ensure(ctx, 90);
    ctx.y -= 10;
    ctx.page.drawRectangle({
      x: MARGIN - 6, y: ctx.y - 5, width: CONTENT_W + 12, height: 21, color: BAND,
    });
    text(ctx, `Photos and videos (${attachments.length})`, MARGIN, 12, bold);
    ctx.y -= 26;

    // Two to a row, each as tall as it needs to be — a photo squeezed into a
    // fixed box tells you less than a smaller one that kept its shape.
    const cellW = (CONTENT_W - 16) / 2;
    const cellH = 150;
    let column = 0;
    let rowTop = ctx.y;

    for (const photo of photos) {
      const bytes = await loadAttachment(photo);
      if (!bytes) continue; // listed below with the rest of what couldn't be drawn
      let image;
      try {
        image = photo.mime === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      } catch {
        continue;
      }
      if (column === 0) {
        ensure(ctx, cellH + 24);
        rowTop = ctx.y;
      }
      const scale = Math.min(cellW / image.width, cellH / image.height);
      const w = image.width * scale, h = image.height * scale;
      const x = MARGIN + column * (cellW + 16);
      ctx.page.drawImage(image, { x, y: rowTop - h, width: w, height: h });
      ctx.page.drawText(winAnsi(photo.name).slice(0, 46), {
        x, y: rowTop - h - 11, size: 7.5, font: regular, color: MUTED,
      });
      if (column === 1) { ctx.y = rowTop - cellH - 22; column = 0; }
      else { column = 1; }
    }
    if (column === 1) ctx.y = rowTop - cellH - 22; // the row that was left half full

    if (videos.length) {
      ensure(ctx, 26 + videos.length * 12);
      ctx.y -= 4;
      text(ctx, "Videos are kept with this record and are not printable:", MARGIN, 8.5, regular, MUTED);
      ctx.y -= 13;
      for (const video of videos) {
        ensure(ctx, 14);
        const size = video.size ? ` (${(video.size / 1e6).toFixed(1)} MB)` : "";
        text(ctx, `- ${video.name}${size}`, MARGIN, 9, regular);
        ctx.y -= 12;
      }
      ctx.y -= 4;
    }
  }

  // ---- certification and terms ---------------------------------------------
  // The whole block is kept together: a certification on one page and the
  // signature that answers it on another is the arrangement anyone would
  // question later.
  const signedOn = new Date(c.signedAt).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
  ensure(ctx, 300);
  ctx.y -= 20;
  text(ctx, "Certification", MARGIN, 12, bold);
  ctx.y -= 18;

  // Drawn as a ticked box rather than described as one, so the PDF shows what
  // the tenant actually did on screen.
  const boxSize = 10;
  ctx.page.drawRectangle({
    x: MARGIN, y: ctx.y - 1, width: boxSize, height: boxSize,
    borderColor: INK, borderWidth: 0.9, color: rgb(1, 1, 1),
  });
  ctx.page.drawLine({
    start: { x: MARGIN + 2, y: ctx.y + 4 }, end: { x: MARGIN + 4, y: ctx.y + 1 },
    thickness: 1.3, color: INK,
  });
  ctx.page.drawLine({
    start: { x: MARGIN + 4, y: ctx.y + 1 }, end: { x: MARGIN + 8.5, y: ctx.y + 7.5 },
    thickness: 1.3, color: INK,
  });
  const certLines = wrap(c.certification, bold, 9.5, CONTENT_W - boxSize - 8);
  certLines.forEach((line, i) => {
    if (i > 0) ctx.y -= 12;
    text(ctx, line, MARGIN + boxSize + 8, 9.5, bold);
  });
  ctx.y -= 20;

  for (const clause of c.acknowledgements ?? []) {
    const lines = wrap(clause, regular, 8.5, CONTENT_W - 10);
    ensure(ctx, lines.length * 10.5 + 6);
    lines.forEach((line, i) => {
      if (i === 0) text(ctx, "-", MARGIN, 8.5, regular, MUTED);
      text(ctx, line, MARGIN + 10, 8.5, regular, MUTED);
      ctx.y -= 10.5;
    });
    ctx.y -= 2;
  }

  // ---- signatures ----------------------------------------------------------
  const hasAgent = Boolean(c.agentSignature && c.agentName);
  ensure(ctx, hasAgent ? 210 : 120);
  ctx.y -= 14;

  const box = { w: 210, h: 62 };
  const gap = CONTENT_W - box.w * 2 > 24 ? CONTENT_W - box.w * 2 : 24;

  /** One signature: the mark, a rule under it, then who and when. */
  async function signature(x: number, png64: string, who: string, role: string, when: string, top: number) {
    const png = await doc.embedPng(png64);
    // Fit inside the box without stretching it; a signature squashed to fit is
    // not the mark the person made.
    const scale = Math.min(box.w / png.width, box.h / png.height, 1);
    ctx.page.drawImage(png, {
      x, y: top - png.height * scale, width: png.width * scale, height: png.height * scale,
    });
    const rule = top - box.h;
    ctx.page.drawLine({ start: { x, y: rule }, end: { x: x + box.w, y: rule }, thickness: 0.75, color: INK });
    ctx.page.drawText(winAnsi(who), { x, y: rule - 12, size: 9.5, font: regular, color: INK });
    ctx.page.drawText(winAnsi(role), { x, y: rule - 23, size: 8, font: regular, color: MUTED });
    ctx.page.drawText(winAnsi(when), { x, y: rule - 34, size: 8, font: regular, color: MUTED });
  }

  const top = ctx.y;
  const agentX = MARGIN + box.w + gap;
  await signature(MARGIN, c.signature, c.name, "Tenant signature", signedOn, top);

  if (hasAgent) {
    await signature(agentX, c.agentSignature!, c.agentName!, "Agent signature", signedOn, top);
  } else {
    // A ruled line either way, so a countersignature can be added by hand on a
    // printed copy rather than the page simply ending at the tenant. A named
    // agent who didn't sign here still gets their name under it.
    const rule = top - box.h;
    ctx.page.drawLine({
      start: { x: agentX, y: rule }, end: { x: agentX + box.w, y: rule },
      thickness: 0.75, color: c.agentName ? INK : RULE,
    });
    if (c.agentName) {
      ctx.page.drawText(winAnsi(c.agentName), { x: agentX, y: rule - 12, size: 9.5, font: regular, color: INK });
      ctx.page.drawText("Agent signature", { x: agentX, y: rule - 23, size: 8, font: regular, color: MUTED });
      ctx.page.drawText("Not signed electronically", { x: agentX, y: rule - 34, size: 8, font: regular, color: MUTED });
    } else {
      ctx.page.drawText("Agent signature (no agent present at inspection)", {
        x: agentX, y: rule - 12, size: 8, font: regular, color: MUTED,
      });
    }
  }
  ctx.y = top - box.h - 38;

  // Anyone else who signed on the day, in the same grid, two to a row. These
  // are part of what was signed — unlike a signature added to the report
  // afterwards, which the CRM prints in an addendum after these pages.
  const others = c.extraSignatures ?? [];
  for (let i = 0; i < others.length; i += 2) {
    const row = others.slice(i, i + 2);
    // A mark and the name under it belong on one page, always.
    ensure(ctx, box.h + 46);
    const rowTop = ctx.y;
    for (const [column, other] of row.entries()) {
      await signature(
        column === 0 ? MARGIN : agentX,
        other.signature,
        other.name,
        other.role,
        signedOn,
        rowTop
      );
    }
    ctx.y = rowTop - box.h - 38;
  }

  // ---- footers -------------------------------------------------------------
  // Written last, when the page count is finally known.
  ctx.pages.forEach((page, i) => {
    const label = `${winAnsi(c.address)}  ·  page ${i + 1} of ${ctx.pages.length}`;
    page.drawText(winAnsi(label), {
      x: MARGIN, y: MARGIN - 18, size: 8, font: regular, color: MUTED,
    });
    page.drawText(`Ref ${c.id.slice(0, 8)}`, {
      x: PAGE.w - MARGIN - regular.widthOfTextAtSize(`Ref ${c.id.slice(0, 8)}`, 8),
      y: MARGIN - 18, size: 8, font: regular, color: MUTED,
    });
  });

  return await doc.save();
}
