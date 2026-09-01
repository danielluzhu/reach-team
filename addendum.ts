/**
 * Comments and signatures added to an inspection after it was signed, appended
 * to the signed PDF as an addendum.
 *
 * The signed pages are never touched. They are the document a tenant and an
 * agent put their names to, and a record that can be edited afterwards is worth
 * nothing in a deposit dispute — so anything the office adds later goes on
 * pages of its own, after the signature, each one saying what it is and when it
 * was added. The file in `checklist/pdfs/` stays exactly as it was written on
 * the day; the addendum is built onto a copy as the PDF is served.
 *
 * Laid out the way checklist/pdf.ts lays out the signed pages — same A4, same
 * margins, same Helvetica — so the addendum reads as part of the same document
 * rather than something stapled on from another system.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const PAGE = { w: 595.28, h: 841.89 }; // A4 portrait, in points
const MARGIN = 48;
const CONTENT_W = PAGE.w - MARGIN * 2;

const INK = rgb(0.1, 0.11, 0.12);
const MUTED = rgb(0.42, 0.45, 0.49);
const RULE = rgb(0.85, 0.87, 0.89);
const FLAG = rgb(0.6, 0.11, 0.11);

export type AddendumNote = {
  id: number;
  body: string;
  author: string;
  authorName: string | null;
  createdAt: string;
};

/**
 * A signature put to the report after it was signed. The PNG is the mark the
 * canvas produced; the remark is whatever the signer wanted on the record,
 * which is often nothing.
 */
export type AddendumSignature = {
  id: number;
  name: string;
  role: string;
  remark: string;
  /** A PNG data URL. */
  signature: string;
  signedAt: string;
  addedBy: string;
  addedByName: string | null;
  /** Set when it was signed remotely, on a link the office sent out. */
  linkId?: number | null;
};

export type AddendumMeta = {
  /** The checklist id, so an addendum page can't be filed against the wrong report. */
  id: string;
  address: string;
  tenant: string;
  signedAt: string;
  /** How many pages the signed document has, for the "after page N" wording. */
  signedPages: number;
};

/**
 * The standard PDF fonts are WinAnsi-encoded and pdf-lib throws on a character
 * it can't encode. A comment is typed by a person, often pasted from a phone or
 * an email, so this is not a theoretical problem: fold what has an obvious
 * equivalent and drop the rest, exactly as the signed pages do.
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
function wrapLine(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = winAnsi(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${line} ${word}`;
    if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

/** Wrap, keeping the blank lines a person typed — paragraphs are meaning here. */
function wrapBody(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of String(text ?? "").split(/\r?\n/)) {
    if (!paragraph.trim()) {
      // Never open a comment or double up on blank lines.
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }
    lines.push(...wrapLine(paragraph, font, size, width));
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The PNG behind a data URL, or null if it isn't one we can draw. */
function pngBytes(dataUrl: string): Uint8Array | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ""));
  if (!match) return null;
  try {
    return new Uint8Array(Buffer.from(match[1], "base64"));
  } catch {
    return null;
  }
}

const STAMP_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: process.env.CHECKLIST_TZ ?? "America/Los_Angeles",
  year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

function stamp(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : STAMP_FORMAT.format(at);
}

/**
 * The signed PDF with everything added since appended to it: signatures put to
 * the report after it was submitted, then the comments. Returns the bytes
 * unchanged when there is nothing to add, so an inspection nobody has touched
 * serves the file straight off the disk.
 */
export async function appendAddendum(
  signed: Uint8Array,
  meta: AddendumMeta,
  notes: AddendumNote[],
  signatures: AddendumSignature[] = []
): Promise<Uint8Array> {
  if (!notes.length && !signatures.length) return signed;

  const doc = await PDFDocument.load(signed);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

  const added: PDFPage[] = [];
  let page = doc.addPage([PAGE.w, PAGE.h]);
  added.push(page);
  let y = PAGE.h - MARGIN;

  const nextPage = () => {
    page = doc.addPage([PAGE.w, PAGE.h]);
    added.push(page);
    y = PAGE.h - MARGIN;
  };
  /** Start a new page when `needed` points wouldn't clear the bottom margin. */
  const ensure = (needed: number) => {
    if (y - needed < MARGIN + 28) nextPage();
  };
  const draw = (s: string, x: number, size: number, font: PDFFont, color = INK) => {
    page.drawText(winAnsi(s), { x, y, size, font, color });
  };

  // ---- heading -------------------------------------------------------------
  // Named for what is actually on it. A document headed "comments" that turns
  // out to carry a signature is the kind of surprise this addendum exists to
  // avoid.
  const title = signatures.length
    ? notes.length
      ? "Addendum - added after signing"
      : "Addendum - signatures added after signing"
    : "Addendum - comments added after signing";
  y -= 6;
  draw(title, MARGIN, 16, bold);
  y -= 17;
  draw(`${meta.address}  ·  ${meta.tenant}`, MARGIN, 10.5, regular, MUTED);
  y -= 13;
  const precede = meta.signedPages
    ? ` · ${meta.signedPages} signed page${meta.signedPages === 1 ? "" : "s"} precede this addendum`
    : "";
  draw(
    `Checklist signed ${stamp(meta.signedAt)} · ref ${meta.id.slice(0, 8)}${precede}`,
    MARGIN,
    8.5,
    regular,
    MUTED
  );
  y -= 18;
  page.drawLine({
    start: { x: MARGIN, y }, end: { x: PAGE.w - MARGIN, y },
    thickness: 1, color: RULE,
  });
  y -= 20;

  // The one thing a reader of this page has to understand, said before the
  // contents rather than in a footnote after them.
  const preamble = signatures.length
    ? "Everything on these pages was added after the checklist was signed. Nothing here changes " +
      "what was recorded on the day: the conditions, the notes and the signatures on the pages " +
      "above are as they were certified. The signatures below were made later, each by the person " +
      "named against it, and each is shown with the time it was made and the account that " +
      "captured it." +
      (notes.length
        ? " The comments that follow them were written by the office and are signed by nobody."
        : "")
    : "These comments were added after the checklist was signed. They are not part of what " +
      "the tenant and the agent certified on the pages above, and neither party has signed them. " +
      "Each is shown with who wrote it and when.";
  for (const line of wrapLine(preamble, italic, 9, CONTENT_W)) {
    draw(line, MARGIN, 9, italic, MUTED);
    y -= 12;
  }
  y -= 10;

  /** A heading over a run of entries, used only when there are two runs. */
  const section = (label: string) => {
    ensure(30);
    draw(label, MARGIN, 11.5, bold);
    y -= 16;
  };

  // ---- signatures made after the fact ---------------------------------------
  if (signatures.length) {
    if (notes.length) section("Signatures");
    for (const [index, sig] of signatures.entries()) {
      const remarkLines = wrapBody(sig.remark, regular, 10, CONTENT_W - 12);
      const bytes = pngBytes(sig.signature);
      let mark = null;
      try {
        mark = bytes ? await doc.embedPng(bytes) : null;
      } catch {
        // A signature that can't be embedded still gets its line: the fact that
        // this person signed is the record, and dropping the entry would hide it.
        mark = null;
      }
      const scale = mark ? Math.min(180 / mark.width, 44 / mark.height, 1) : 0;
      const markW = mark ? mark.width * scale : 0;
      const markH = mark ? mark.height * scale : 0;

      // The mark, the name and the stamp belong together on one page.
      ensure(16 + markH + 26 + Math.min(remarkLines.length, 2) * 13);

      const who = `${index + 1}.  ${sig.name}`;
      draw(who, MARGIN, 10.5, bold);
      draw(
        `  ·  ${sig.role}`,
        MARGIN + bold.widthOfTextAtSize(winAnsi(who), 10.5),
        9,
        regular,
        MUTED
      );
      y -= 15;

      if (mark) {
        page.drawImage(mark, { x: MARGIN + 12, y: y - markH, width: markW, height: markH });
        y -= markH + 3;
      } else {
        draw("(signature on file; it could not be drawn here)", MARGIN + 12, 9, italic, MUTED);
        y -= 12;
      }
      page.drawLine({
        start: { x: MARGIN + 12, y }, end: { x: MARGIN + 12 + Math.max(markW, 180), y },
        thickness: 0.75, color: RULE,
      });
      y -= 12;

      // How the mark was taken is part of the record: a signature made on a
      // link, by somebody at their own kitchen table, is a different act from
      // one taken on the office's laptop, and the page says which.
      const how = sig.linkId
        ? `signed remotely, on a link sent by ${sig.addedByName || sig.addedBy}`
        : `captured by ${sig.addedByName || sig.addedBy}`;
      draw(`Signed ${stamp(sig.signedAt)}  ·  ${how}`, MARGIN + 12, 8.5, regular, MUTED);
      y -= 14;

      for (const line of remarkLines) {
        ensure(13);
        draw(line, MARGIN + 12, 10, regular);
        y -= 13;
      }
      y -= 10;
    }
    if (notes.length) {
      y -= 2;
      section("Comments");
    }
  }

  // ---- the comments --------------------------------------------------------
  notes.forEach((note, index) => {
    const bodyLines = wrapBody(note.body, regular, 10, CONTENT_W - 12);
    // Keep the attribution with at least the first two lines of what it
    // attributes; a name alone at the foot of a page reads as an orphan.
    ensure(14 + Math.min(bodyLines.length, 2) * 13 + 12);

    const who = `${index + 1}.  ${note.authorName || note.author}`;
    draw(who, MARGIN, 10.5, bold);
    draw(
      `  ·  ${stamp(note.createdAt)}`,
      MARGIN + bold.widthOfTextAtSize(winAnsi(who), 10.5),
      9,
      regular,
      MUTED
    );
    y -= 15;

    for (const line of bodyLines) {
      ensure(13);
      draw(line, MARGIN + 12, 10, regular);
      y -= 13;
    }
    y -= 10;
  });

  // ---- footers -------------------------------------------------------------
  // The signed pages keep the footers they were signed with — "page 2 of 5" on
  // a five-page document that is now seven pages long is the truth about what
  // was signed. The addendum numbers itself separately and says so.
  added.forEach((p, i) => {
    const label = `Addendum  ·  page ${i + 1} of ${added.length}  ·  added after signing`;
    p.drawText(winAnsi(label), { x: MARGIN, y: MARGIN - 18, size: 8, font: regular, color: FLAG });
    const ref = `Ref ${meta.id.slice(0, 8)}`;
    p.drawText(ref, {
      x: PAGE.w - MARGIN - regular.widthOfTextAtSize(ref, 8),
      y: MARGIN - 18, size: 8, font: regular, color: MUTED,
    });
  });

  return await doc.save();
}
