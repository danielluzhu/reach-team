import { randomUUID } from "node:crypto";
import { FAVICON_LINK } from "./auth";
import { db } from "./db";
import { PAGE_CSS } from "./inspections";

/**
 * The driveway log: cars parked where they shouldn't be.
 *
 * This is a small table with one job, which is spotting the same car twice.
 * Everything here follows from that — the normalised plate, the index on it,
 * and a page that shows the repeats in red rather than making somebody read
 * a hundred rows looking for a number they half remember.
 */

export const PLATE_UPLOAD_DIR = process.env.PLATE_UPLOAD_DIR ?? "uploads/plates";

/** Two photos: the plate itself, and a wider shot showing where the car was. */
export const MAX_PHOTOS = 2;
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

/** What a phone camera produces, and nothing else. */
const PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/webp": "webp",
};

export const acceptedPhotoTypes = () => Object.keys(PHOTO_TYPES);

/**
 * The plate as it is matched on: upper case, letters and digits only.
 *
 * People write the same plate differently every time — "7ABC123", "7abc-123",
 * "7 ABC 123" — and a repeat that doesn't collide is a repeat nobody sees. The
 * form they typed is stored separately and is what gets shown.
 */
export function normalizePlate(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** US states, plus the honest option for a plate nobody got a good look at. */
export const STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME",
  "MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA",
  "RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC","BC","AB","ON","Unknown",
];

/** Settings key holding what the form starts filled in with. */
const DEFAULTS_KEY = "plate_defaults";

const readSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const writeSetting = db.prepare(
  `INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET
     value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
);

export type PlateDefaults = { state: string; location: string; notes: string };

/**
 * What the form starts filled in with.
 *
 * Almost every report is the same driveway and the same complaint, so the
 * common case should be one field and a button. Which driveway that is belongs
 * to whoever runs the place, not to this file — it lives in settings, like the
 * property addresses, and the repository stays free of anybody's street.
 */
export function plateDefaults(): PlateDefaults {
  const row = readSetting.get(DEFAULTS_KEY) as { value: string } | undefined;
  const stored = row ? (() => { try { return JSON.parse(row.value); } catch { return {}; } })() : {};
  return {
    state: typeof stored.state === "string" && STATES.includes(stored.state) ? stored.state : "WA",
    location: typeof stored.location === "string" ? stored.location : "",
    notes: typeof stored.notes === "string" ? stored.notes : "",
  };
}

export function setPlateDefaults(next: Partial<PlateDefaults>, updatedBy: string): PlateDefaults {
  const merged = { ...plateDefaults(), ...next };
  writeSetting.run(DEFAULTS_KEY, JSON.stringify(merged), updatedBy);
  return merged;
}

export type PlateReport = {
  id: number;
  plate: string;
  plate_typed: string;
  state: string;
  reported_on: string;
  location: string | null;
  notes: string | null;
  color: string | null;
  year: string | null;
  make: string | null;
  model: string | null;
  photo1: string | null;
  photo2: string | null;
  reported_by: string;
  created_at: string;
};

export type AllowedCar = {
  id: number;
  plate: string;
  plate_typed: string;
  state: string;
  label: string;
  added_by: string;
  created_at: string;
};

const allowedQuery = db.query(
  `SELECT * FROM plate_whitelist WHERE removed_at IS NULL ORDER BY label COLLATE NOCASE, id`
);
const insertAllowed = db.prepare(
  `INSERT INTO plate_whitelist (plate, plate_typed, state, label, added_by, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const removeAllowed = db.prepare(
  `UPDATE plate_whitelist SET removed_at = ?, removed_by = ? WHERE id = ? AND removed_at IS NULL`
);

export function listAllowed(): AllowedCar[] {
  return allowedQuery.all() as AllowedCar[];
}

/** The allowed car for a plate, however that plate was typed, or null. */
export function allowedFor(rawPlate: string): AllowedCar | null {
  const normalized = normalizePlate(rawPlate);
  return listAllowed().find((a) => a.plate === normalized) ?? null;
}

export function allowCar(plate: string, state: string, label: string, by: string): AllowedCar {
  insertAllowed.run(
    normalizePlate(plate),
    plate.trim(),
    state,
    label.trim(),
    by,
    new Date().toISOString()
  );
  return allowedFor(plate)!;
}

export function disallowCar(id: number, by: string): boolean {
  return removeAllowed.run(new Date().toISOString(), by, id).changes > 0;
}

/** A report, plus where it sits in that plate's history. */
export type PlateRow = PlateReport & {
  /** How many times this plate has been logged in total. */
  timesSeen: number;
  /** 1 for the first sighting of this plate, 2 for the next, and so on. */
  occurrence: number;
  /** Every state this plate has been reported under — usually one. */
  states: string[];
  /** Set when this plate is on the allowed list: whose car it is. */
  allowed: AllowedCar | null;
};

const insertReport = db.prepare(
  `INSERT INTO plate_reports
     (plate, plate_typed, state, reported_on, location, notes,
      color, year, make, model, photo1, photo2, reported_by, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const allReports = db.query(
  `SELECT * FROM plate_reports WHERE deleted_at IS NULL
   ORDER BY reported_on DESC, id DESC`
);

const softDelete = db.prepare(
  `UPDATE plate_reports SET deleted_at = ?, deleted_by = ? WHERE id = ? AND deleted_at IS NULL`
);

/**
 * Every report, newest first, each told how many times its plate has been
 * seen and which sighting it is.
 *
 * Counting happens here rather than in SQL because the page needs both the
 * total and the position, and a window function would be harder to read than
 * two passes over a table that will never be large.
 */
export function listReports(): PlateRow[] {
  const reports = allReports.all() as PlateReport[];

  const byPlate = new Map<string, PlateReport[]>();
  for (const r of reports) {
    const seen = byPlate.get(r.plate) ?? [];
    seen.push(r);
    byPlate.set(r.plate, seen);
  }

  const ordinal = new Map<number, number>();
  const states = new Map<string, string[]>();
  for (const [plate, group] of byPlate) {
    // The list is newest first, so the oldest sighting is the first one.
    [...group].reverse().forEach((r, i) => ordinal.set(r.id, i + 1));
    states.set(plate, [...new Set(group.map((r) => r.state))]);
  }

  // An allowed car is not a violation, however many times it appears, so it is
  // never counted as a repeat — that is the whole point of the list.
  const allowed = new Map(listAllowed().map((a) => [a.plate, a]));

  return reports.map((r) => ({
    ...r,
    timesSeen: byPlate.get(r.plate)!.length,
    occurrence: ordinal.get(r.id)!,
    states: states.get(r.plate)!,
    allowed: allowed.get(r.plate) ?? null,
  }));
}

/** Today where the cars are, not where the server is. */
export function today(timeZone = "America/Los_Angeles"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export type SavedPhoto = { id: string; ext: string };

/**
 * Writes one uploaded photo and returns the id to store, or an error to show.
 *
 * The filename never comes from the browser: the id is generated here and the
 * extension is chosen from the type this app recognised, so nothing a caller
 * sends can reach outside the upload directory.
 */
function photoProblem(file: File): string | null {
  if (!PHOTO_TYPES[file.type.split(";")[0]!.trim().toLowerCase()]) {
    return `${file.name || "That file"} isn't a photo this app can store`;
  }
  if (file.size > MAX_PHOTO_BYTES) {
    return `${file.name || "That photo"} is over ${MAX_PHOTO_BYTES / 1024 / 1024}MB`;
  }
  return null;
}

/**
 * Writes the photos for one report, or writes none of them.
 *
 * Every file is checked before any is written: a good first photo and a bad
 * second one used to leave the first on disk with no report pointing at it,
 * which is a file nobody can see and nobody deletes.
 */
export async function savePhotos(files: File[]): Promise<{ ids?: string[]; error?: string }> {
  for (const file of files) {
    const problem = photoProblem(file);
    if (problem) return { error: problem };
  }
  const ids: string[] = [];
  for (const file of files) {
    const ext = PHOTO_TYPES[file.type.split(";")[0]!.trim().toLowerCase()]!;
    const id = `${randomUUID()}.${ext}`;
    await Bun.write(`${PLATE_UPLOAD_DIR}/${id}`, file);
    ids.push(id);
  }
  return { ids };
}

export type NewReport = {
  plate: string;
  state: string;
  location?: string;
  notes?: string;
  color?: string;
  year?: string;
  make?: string;
  model?: string;
  photos: string[];
  reportedBy: string;
};

/** Blank stays blank rather than becoming an empty string in the record. */
const orNull = (value?: string) => value?.trim() || null;

export function addReport(report: NewReport): number {
  const normalized = normalizePlate(report.plate);
  const info = insertReport.run(
    normalized,
    report.plate.trim(),
    report.state,
    today(),
    orNull(report.location),
    orNull(report.notes),
    orNull(report.color),
    orNull(report.year),
    orNull(report.make),
    orNull(report.model),
    report.photos[0] ?? null,
    report.photos[1] ?? null,
    report.reportedBy,
    new Date().toISOString()
  );
  return Number(info.lastInsertRowid);
}

export function deleteReport(id: number, by: string): boolean {
  return softDelete.run(new Date().toISOString(), by, id).changes > 0;
}

/**
 * Serves a stored photo. The name is checked against the shape this app
 * generates rather than trusted, so a crafted path can't escape the directory.
 */
export async function servePlatePhoto(name: string): Promise<Response> {
  if (!/^[0-9a-f-]{36}\.(jpg|png|heic|heif|webp)$/.test(name)) {
    return new Response("Not found", { status: 404 });
  }
  const file = Bun.file(`${PLATE_UPLOAD_DIR}/${name}`);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file, {
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "Cache-Control": "no-store, private",
    },
  });
}

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** "2026-08-29" → "Fri 29 Aug", which is how a log is skimmed. */
function niceDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short", day: "numeric", month: "short", timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export const PLATES_CSS = `
    /* Red is the whole message of this page, so it is named once here. */
    :root { --repeat: #b91c1c; --repeat-bg: #fef2f2; --ok: #15803d; --ok-bg: #f0fdf4; }
    .plates-intro { color: var(--muted); margin: 0 0 18px; max-width: 70ch; }
    .plate-form {
      display: grid; gap: 12px; padding: 16px; margin-bottom: 24px;
      border: 1px solid var(--line); border-radius: 10px; background: #fff;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      align-items: end;
    }
    .plate-form label { display: grid; gap: 5px; font-size: 13px; color: var(--muted); }
    .plate-form input, .plate-form select {
      font: inherit; padding: 8px 10px; border: 1px solid var(--line);
      border-radius: 7px; background: #fff; color: var(--ink);
    }
    /* A plate is read back character by character, so it is set in a face where
       nothing is ambiguous, and typed in upper case whatever the caps lock says. */
    .plate-form input[name="plate"], td.plate {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .plate-form .wide { grid-column: 1 / -1; }
    .plate-form .photos { display: grid; gap: 5px; }
    .plate-form button {
      font: inherit; padding: 9px 18px; border: 0; border-radius: 7px;
      background: var(--accent); color: #fff; cursor: pointer;
    }
    .plate-hint { font-size: 12px; color: var(--muted); }
    .plates-table { width: 100%; border-collapse: collapse; }
    .plates-table th, .plates-table td {
      padding: 9px 10px; border-bottom: 1px solid var(--line);
      text-align: left; vertical-align: top; font-size: 14px;
    }
    .plates-table th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
    td.plate { font-weight: 600; white-space: nowrap; }
    /* A repeat is the whole point of the page, so it is coloured, outlined and
       labelled — not colour alone, which some readers cannot use. */
    tr.repeat td { background: var(--repeat-bg); }
    tr.repeat td.plate { box-shadow: inset 3px 0 0 var(--repeat); color: var(--repeat); }
    .repeat-badge {
      display: inline-block; margin-left: 7px; padding: 1px 7px; border-radius: 999px;
      font-size: 11px; font-weight: 700; background: var(--repeat); color: #fff;
      letter-spacing: 0; text-transform: none; font-family: system-ui, sans-serif;
    }
    .first-badge {
      display: inline-block; margin-left: 7px; font-size: 11px; color: var(--muted);
      letter-spacing: 0; text-transform: none; font-family: system-ui, sans-serif;
    }
    .plate-photos { display: flex; gap: 6px; }
    .plate-photos a { line-height: 0; }
    .plate-photos img {
      width: 62px; height: 46px; object-fit: cover;
      border-radius: 5px; border: 1px solid var(--line);
    }
    /* An allowed car is not a violation, so it reads as settled, not as an
       alarm — and it is labelled, because green and red alone are the one pair
       a colour-blind reader is least able to separate. */
    tr.allowed td { background: var(--ok-bg); }
    tr.allowed td.plate { box-shadow: inset 3px 0 0 var(--ok); color: var(--ok); }
    .ok-badge {
      display: inline-block; margin-left: 7px; padding: 1px 7px; border-radius: 999px;
      font-size: 11px; font-weight: 700; background: var(--ok); color: #fff;
      letter-spacing: 0; text-transform: none; font-family: system-ui, sans-serif;
    }
    .plates-section { margin-top: 40px; }
    .plates-section h2 { font-size: 1.15rem; margin: 0 0 6px; }
    .plates-section p { color: var(--muted); margin: 0 0 14px; max-width: 70ch; font-size: 0.9rem; }
    .allow-form { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    .allowed-table { width: auto; min-width: min(100%, 620px); }
    .plates-empty { color: var(--muted); padding: 28px 0; }
    .plate-notice {
      padding: 10px 14px; margin-bottom: 16px; border-radius: 8px;
      background: var(--ok-bg); color: var(--ok); border: 1px solid var(--ok);
    }
    .plate-error {
      padding: 10px 14px; margin-bottom: 16px; border-radius: 8px;
      background: var(--repeat-bg); color: var(--repeat); border: 1px solid var(--repeat);
    }
    .plate-note { white-space: pre-wrap; }
    .plate-del { background: none; border: 0; color: var(--muted); cursor: pointer; font: inherit; padding: 0; }
    .plate-del:hover { color: var(--repeat); }
`;

/**
 * "Grey 2019 Mazda 3" from whichever of the four fields were filled in.
 *
 * They are shown as one phrase rather than four columns because that is how a
 * car is described out loud, and because most reports will have two of them.
 */
export function describeCar(r: {
  color: string | null;
  year: string | null;
  make: string | null;
  model: string | null;
}): string {
  return [r.color, r.year, r.make, r.model].map((v) => v?.trim()).filter(Boolean).join(" ");
}

/** One row, and the whole reason for the colour. */
function renderRow(r: PlateRow): string {
  // Allowed beats repeat: a tenant's own car parked in the drive ten times is
  // not ten violations, and colouring it red would train people to ignore red.
  const isRepeat = !r.allowed && r.occurrence > 1;
  const photos = [r.photo1, r.photo2].filter(Boolean) as string[];
  const badge = r.allowed
    ? `<span class="ok-badge" title="On the allowed list">ALLOWED</span>` +
      `<span class="first-badge">${escapeHtml(r.allowed.label)}</span>`
    : isRepeat
      ? `<span class="repeat-badge" title="This plate has been logged ${r.timesSeen} times">` +
        `REPEAT · ${r.occurrence} of ${r.timesSeen}</span>`
      : r.timesSeen > 1
        ? `<span class="first-badge">first of ${r.timesSeen}</span>`
        : "";
  const states = r.states.length > 1 ? ` <span class="first-badge">also ${
    escapeHtml(r.states.filter((s) => s !== r.state).join(", "))}</span>` : "";
  return (
    `<tr class="${r.allowed ? "allowed" : isRepeat ? "repeat" : ""}">` +
    `<td>${escapeHtml(niceDate(r.reported_on))}</td>` +
    `<td class="plate">${escapeHtml(r.plate_typed)}${badge}</td>` +
    `<td>${escapeHtml(r.state)}${states}</td>` +
    `<td>${escapeHtml(describeCar(r))}</td>` +
    `<td>${escapeHtml(r.location ?? "")}</td>` +
    `<td class="plate-note">${escapeHtml(r.notes ?? "")}</td>` +
    `<td class="plate-photos">${photos
      .map(
        (p) =>
          `<a href="/plates/photo/${escapeHtml(p)}" target="_blank" rel="noopener">` +
          `<img src="/plates/photo/${escapeHtml(p)}" alt="Photo of ${escapeHtml(r.plate_typed)}" loading="lazy" /></a>`
      )
      .join("")}</td>` +
    `<td>${escapeHtml(r.reported_by)}</td>` +
    `<td><form method="POST" action="/plates/${r.id}/delete" ` +
    `onsubmit="return confirm('Remove this report? It stays in the record but leaves the list.')">` +
    `<button class="plate-del" type="submit" title="Remove">×</button></form></td>` +
    `</tr>`
  );
}

/**
 * The page body. The form sits above the log because the common visit is
 * someone standing in the driveway with a phone, adding one.
 */
export function renderPlatesBody(rows: PlateRow[], error?: string, notice?: string): string {
  const defaults = plateDefaults();
  const allowed = listAllowed();
  const repeats = new Set(
    rows.filter((r) => !r.allowed && r.timesSeen > 1).map((r) => r.plate)
  );
  const summary = rows.length
    ? `${rows.length} report${rows.length === 1 ? "" : "s"}` +
      (repeats.size ? ` · ${repeats.size} plate${repeats.size === 1 ? "" : "s"} seen more than once` : "")
    : "";

  return `
  <h1>Driveway plates</h1>
  <p class="plates-intro">Cars parked in the driveway that shouldn't be. Log the plate and
  it dates itself. A plate that turns up again is marked
  <span class="repeat-badge">REPEAT</span> in red, so a one-off and a habit don't look alike.
  ${escapeHtml(summary)}</p>

  ${error ? `<p class="plate-error">${escapeHtml(error)}</p>` : ""}
  ${notice ? `<p class="plate-notice">${escapeHtml(notice)}</p>` : ""}

  <form class="plate-form" method="POST" action="/plates" enctype="multipart/form-data">
    <label>Plate number
      <input name="plate" required maxlength="12" autocomplete="off" autocapitalize="characters"
             spellcheck="false" placeholder="7ABC123" />
    </label>
    <label>State
      <select name="state" required>
        ${STATES.map(
          (s) => `<option value="${s}"${s === defaults.state ? " selected" : ""}>${s}</option>`
        ).join("")}
      </select>
    </label>
    <label>Colour
      <input name="color" maxlength="30" placeholder="Grey" />
    </label>
    <label>Year
      <input name="year" maxlength="4" inputmode="numeric" pattern="[0-9]{4}" placeholder="2019" />
    </label>
    <label>Make
      <input name="make" maxlength="40" placeholder="Mazda" />
    </label>
    <label>Model
      <input name="model" maxlength="40" placeholder="3" />
    </label>
    <label>Where
      <input name="location" maxlength="120" value="${escapeHtml(defaults.location)}"
             placeholder="Which property, or where on it" />
    </label>
    <label class="photos">Photos (up to ${MAX_PHOTOS})
      <input type="file" name="photos" accept="image/*" capture="environment" multiple />
      <span class="plate-hint">Plate and a wider shot. Dated today automatically.</span>
    </label>
    <label class="wide">Notes
      <input name="notes" maxlength="400" value="${escapeHtml(defaults.notes)}"
             placeholder="Silver sedan, left for two hours" />
    </label>
    <div><button type="submit">Log it</button></div>
  </form>

  ${
    rows.length
      ? `<table class="plates-table">
          <thead><tr>
            <th>Date</th><th>Plate</th><th>State</th><th>Car</th><th>Where</th>
            <th>Notes</th><th>Photos</th><th>Logged by</th><th></th>
          </tr></thead>
          <tbody>${rows.map(renderRow).join("")}</tbody>
        </table>`
      : `<p class="plates-empty">Nothing logged yet. The first car goes in above.</p>`
  }

  <section class="plates-section">
    <h2>Allowed cars</h2>
    <p>Cars that belong here — tenants, a vendor who visits, your own. Logging one
    is refused with a note saying whose it is, and if one is already in the log it
    reads <span class="ok-badge">ALLOWED</span> instead of counting as a repeat.
    Without this the same legitimate plates fill the log and the red stops meaning
    anything.</p>

    <form class="plate-form allow-form" method="POST" action="/plates/allowed">
      <label>Plate number
        <input name="plate" required maxlength="12" autocomplete="off"
               autocapitalize="characters" spellcheck="false" placeholder="7ABC123" />
      </label>
      <label>State
        <select name="state" required>
          ${STATES.map(
            (s) => `<option value="${s}"${s === defaults.state ? " selected" : ""}>${s}</option>`
          ).join("")}
        </select>
      </label>
      <label>Whose car
        <input name="label" required maxlength="80" placeholder="Unit 3 — blue Civic" />
      </label>
      <div><button type="submit">Allow it</button></div>
    </form>

    ${
      allowed.length
        ? `<table class="plates-table allowed-table">
            <thead><tr><th>Plate</th><th>State</th><th>Whose car</th><th>Added by</th><th></th></tr></thead>
            <tbody>${allowed
              .map(
                (a) =>
                  `<tr class="allowed">` +
                  `<td class="plate">${escapeHtml(a.plate_typed)}</td>` +
                  `<td>${escapeHtml(a.state)}</td>` +
                  `<td>${escapeHtml(a.label)}</td>` +
                  `<td>${escapeHtml(a.added_by)}</td>` +
                  `<td><form method="POST" action="/plates/allowed/${a.id}/remove" ` +
                  `onsubmit="return confirm('Stop allowing ${escapeHtml(a.plate_typed)}? ` +
                  `It will count as a violation from now on.')">` +
                  `<button class="plate-del" type="submit" title="Remove">×</button></form></td>` +
                  `</tr>`
              )
              .join("")}</tbody>
          </table>`
        : `<p class="plates-empty">No allowed cars yet.</p>`
    }
  </section>`;
}

/** The whole page, in the same shell every other page here uses. */
export function renderPlatesPage(
  nav: string,
  navCss: string,
  error?: string,
  notice?: string
): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Driveway plates</title>
  ${FAVICON_LINK}
  <style>
${navCss}
${PAGE_CSS}
${PLATES_CSS}
  </style>
</head>
<body>
  ${nav}
  <div class="page">
${renderPlatesBody(listReports(), error, notice)}
  </div>
</body>
</html>`;
}
