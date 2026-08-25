/**
 * Photos and videos attached to a checklist.
 *
 * They arrive before the checklist does — a tenant adds them while walking
 * round, and only signs at the end — so each upload is stored under an id of
 * its own and the submission refers to it. Anything never referred to is swept
 * up later (see sweepOrphans).
 *
 * The file is named from its type, never from what the browser called it: a
 * name that arrives over the wire has no business deciding a path.
 */

export type Attachment = {
  id: string;
  /** What it was called on the phone. Shown to people; never used as a path. */
  name: string;
  kind: "photo" | "video";
  mime: string;
  size: number;
};

export const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "uploads";

/** Photos are downscaled in the browser before they get here; videos are not. */
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const MAX_ATTACHMENTS = 24;

/**
 * What may be stored, and what each type is called on disk. Everything the PDF
 * can embed is a photo; the rest is kept beside the record and listed in it.
 */
const TYPES: Record<string, { ext: string; kind: "photo" | "video" }> = {
  "image/jpeg": { ext: "jpg", kind: "photo" },
  "image/png": { ext: "png", kind: "photo" },
  "video/mp4": { ext: "mp4", kind: "video" },
  "video/quicktime": { ext: "mov", kind: "video" },
  "video/webm": { ext: "webm", kind: "video" },
  "video/x-matroska": { ext: "mkv", kind: "video" },
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
 * Uploads belong to a checklist that may never be signed — someone starts one,
 * takes six photos and closes the tab. Files that no stored checklist refers
 * to are deleted at boot once they're old enough, so that doesn't accumulate.
 *
 * "Old enough" has to outlast the draft the page keeps in the browser, which
 * is seven days: an unsigned checklist waiting on someone's phone still refers
 * to its photos, and this has no way of knowing that. At 24 hours — where this
 * started — a walkthrough left overnight came back to photos that had been
 * deleted underneath it.
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
      if (Date.now() - info.mtimeMs < maxAgeMs) continue; // may still be in a form on someone's phone
      await unlink(`${UPLOAD_DIR}/${name}`);
      removed++;
    } catch {
      // A file that vanished under us is the outcome we wanted anyway.
    }
  }
  return removed;
}
