/**
 * Documents attached to an application: photo ID, pay stubs, an offer letter.
 *
 * They arrive before the application does — picked while the form is being
 * filled in — so each is stored under an id of its own and the submission refers
 * to it. Anything never referred to is swept up later (see sweepOrphans).
 *
 * Write-only from outside. Nothing here serves an upload back to a browser that
 * isn't the CRM's: these are people's IDs, and an id in a URL is not a sign-in.
 */

export type Attachment = {
  id: string;
  /** What it was called on the phone. Shown to people; never used as a path. */
  name: string;
  kind: "image" | "pdf";
  mime: string;
  size: number;
};

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "uploads";

/** Photos are downscaled in the browser first; a PDF is taken as it comes. */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENTS = 12;

const TYPES: Record<string, { ext: string; kind: "image" | "pdf" }> = {
  "image/jpeg": { ext: "jpg", kind: "image" },
  "image/png": { ext: "png", kind: "image" },
  "application/pdf": { ext: "pdf", kind: "pdf" },
};

export const acceptedTypes = () => Object.keys(TYPES);

export function typeOf(mime: string) {
  return TYPES[mime.split(";")[0].trim().toLowerCase()];
}

/** The path a stored attachment lives at. Built only from values we chose. */
export function uploadPath(id: string, mime: string): string | null {
  const type = typeOf(mime);
  if (!type || !/^[0-9a-f-]{36}$/.test(id)) return null;
  return `${UPLOAD_DIR}/${id}.${type.ext}`;
}

/**
 * Files no stored application refers to, once they are old enough that no form
 * still open on somebody's phone could be about to submit them. The page keeps
 * its draft for seven days; this waits thirty.
 */
export const ORPHAN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export async function sweepOrphans(referenced: Set<string>, maxAgeMs = ORPHAN_MAX_AGE_MS) {
  const { readdir, stat, unlink } = await import("node:fs/promises");
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(UPLOAD_DIR);
  } catch {
    return 0; // nothing uploaded yet
  }
  for (const name of names) {
    const id = name.replace(/\.[^.]+$/, "");
    if (referenced.has(id)) continue;
    try {
      const info = await stat(`${UPLOAD_DIR}/${name}`);
      if (Date.now() - info.mtimeMs < maxAgeMs) continue;
      await unlink(`${UPLOAD_DIR}/${name}`);
      removed++;
    } catch {
      // A file that vanished under us is the outcome we wanted anyway.
    }
  }
  return removed;
}
