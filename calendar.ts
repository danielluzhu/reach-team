import { createHash } from "node:crypto";
import { db } from "./db";

/**
 * Turning a new row on the Tours sheet into a Google Calendar event.
 *
 * The event is created by a Google Apps Script web app deployed under the
 * office Google account, not by this server talking to the Calendar API. That
 * choice is deliberate: Apps Script runs *as* the account that deployed it, so
 * the event is owned by that account and the invitations go out from it, with
 * no OAuth client to register and no refresh token sitting on this box. All
 * this app needs is a URL and a shared secret.
 *
 * The trade is that the script is a piece of configuration living in someone's
 * Google account rather than in this repo. `google-apps-script/tour-calendar.gs`
 * is the copy of record — change it there and re-deploy.
 */

/** Where the deployed Apps Script lives, and the secret it checks. */
const WEBHOOK_URL = process.env.CALENDAR_WEBHOOK_URL ?? "";
const WEBHOOK_SECRET = process.env.CALENDAR_WEBHOOK_SECRET ?? "";

/**
 * Always invited, on top of whoever guided the tour — normally the shared
 * office mailbox, so the calendar has a copy of every tour regardless of who
 * ran it. Comma-separated in CALENDAR_STANDING_GUESTS; empty means the guide
 * alone is invited.
 */
export const STANDING_GUESTS = (process.env.CALENDAR_STANDING_GUESTS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Tours run in the city the property is in, which is one city today.
 * Wall-clock times off the sheet are interpreted here, and the Apps Script is
 * told the zone explicitly so a server in UTC and a script defaulting to some
 * other zone can't disagree about what "2:00PM" meant.
 */
export const TOUR_TIMEZONE = "America/Los_Angeles";

/** The sheet almost never fills in End Time, so tours are half an hour. */
export const DEFAULT_MINUTES = 30;

/** Settings key holding the tour guide name → email address map. */
const GUIDES_KEY = "tour_guide_emails";

/** Settings key holding the street line → full postal address map. */
const PROPERTIES_KEY = "property_addresses";

/** Settings key holding the city the properties are in. */
const CITY_KEY = "property_city";

const readSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const writeSetting = db.prepare(
  `INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
   ON CONFLICT(key) DO UPDATE SET
     value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
);

/**
 * First names as they appear in the sheet's Tour Guide column, mapped to the
 * address to invite. The sheet only ever holds a first name, so this is the
 * only place the two are connected. A guide with no entry still gets an event
 * — it just goes out to the office mailbox alone, and the miss is logged.
 */
export function guideEmails(): Record<string, string> {
  const row = readSetting.get(GUIDES_KEY) as { value: string } | undefined;
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.value);
    const out: Record<string, string> = {};
    for (const [name, email] of Object.entries(parsed)) {
      if (typeof email === "string" && email.includes("@")) out[name.trim().toLowerCase()] = email;
    }
    return out;
  } catch {
    return {};
  }
}

export function setGuideEmails(map: Record<string, string>, updatedBy: string) {
  writeSetting.run(GUIDES_KEY, JSON.stringify(map), updatedBy);
}

export type TourEvent = {
  key: string;
  title: string;
  location: string;
  description: string;
  guests: string[];
  /** Local wall time, "YYYY-MM-DD HH:mm:ss". Absent when the tour has no time. */
  start?: string;
  end?: string;
  /** Set instead of start/end when the row has a date but no time. */
  allDayOn?: string;
  timeZone: string;
  virtual: boolean;
  /** Guides named on the row that have no address on file. */
  unknownGuides: string[];
  /**
   * The three fields `key` is derived from, kept alongside it so a save that
   * changes one of them can still be recognised as an edit of an existing
   * tour rather than a brand new one. See `pairRekeyed`.
   */
  identity: { name: string; street: string; date: string };
};

/** Column name → index, so a re-ordered sheet doesn't quietly read the wrong field. */
function columnIndex(columns: any[]): Record<string, number> {
  const idx: Record<string, number> = {};
  columns.forEach((c, i) => {
    if (c && typeof c.name === "string") idx[c.name.trim().toLowerCase()] = i;
  });
  return idx;
}

const cell = (row: any[], idx: Record<string, number>, name: string): string => {
  const i = idx[name.toLowerCase()];
  const v = i === undefined ? "" : row[i];
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
};

/**
 * Full postal address for each property, keyed by the street line as the sheet
 * writes it. Which buildings a company manages is its own business, so this
 * lives in settings rather than in the source — see `calendar properties`.
 * A property with no entry keeps whatever the sheet said.
 */
export function propertyAddresses(): Record<string, string> {
  const row = readSetting.get(PROPERTIES_KEY) as { value: string } | undefined;
  if (!row) return {};
  try {
    const out: Record<string, string> = {};
    for (const [street, full] of Object.entries(JSON.parse(row.value))) {
      if (typeof full === "string") out[street.trim().toLowerCase()] = full;
    }
    return out;
  } catch {
    return {};
  }
}

export function setPropertyAddresses(map: Record<string, string>, updatedBy: string) {
  writeSetting.run(PROPERTIES_KEY, JSON.stringify(map), updatedBy);
}

/**
 * The city the properties are in, used to find where the street line ends.
 * Configured rather than hard-coded, so this reads the same for anyone.
 */
export function propertyCity(): string {
  const row = readSetting.get(CITY_KEY) as { value: string } | undefined;
  return row ? String(JSON.parse(row.value) ?? "") : "";
}

export function setPropertyCity(city: string, updatedBy: string) {
  writeSetting.run(CITY_KEY, JSON.stringify(city), updatedBy);
}

/**
 * The street line, which is what goes in the title. The sheet writes the same
 * property a dozen ways ("12 Example Ave NE", "…, Springfield, ST 12345, USA",
 * "…, Springfield, 12345"), so everything from the city onwards is dropped and
 * a unit number, if there is one, is kept.
 */
export function streetOf(location: string): string {
  let s = location.trim().replace(/\s+/g, " ").replace(/,+$/, "");
  const city = propertyCity();
  // The city is the reliable end of the street line, because the sheet writes
  // it both with and without the comma before it. Without one configured, the
  // first comma is the best guess available.
  s = city
    ? s.split(new RegExp(`,?\\s+${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"))[0]!
    : s.split(",")[0]!;
  return s.trim().replace(/,+$/, "");
}

/** The street line expanded back to something Google Maps can pin. */
export function fullAddress(street: string): string {
  const base = street.split(/\s+(?:#|Unit)\s*/i)[0]!.trim();
  const known = propertyAddresses()[base.toLowerCase()];
  if (!known) return street;
  const unit = street.slice(base.length).trim();
  if (!unit) return known;
  // Keep the unit with the street, before the city.
  return known.replace(base, `${base} ${unit}`);
}

/**
 * "2:30PM", "7.00pm", "12:50PM (1:10PM actual)" → 24h "14:30", plus whatever
 * was in the parentheses. The sheet uses the bracket to record that a tour
 * moved; the booked time is the one outside it, and the note is carried into
 * the description rather than thrown away.
 */
export function parseTime(raw: string): { hhmm: string | null; note: string } {
  let t = raw.trim();
  let note = "";
  const paren = t.match(/^(.*?)\s*\((.*?)\)\s*$/);
  if (paren) {
    t = paren[1]!.trim();
    note = paren[2]!.trim();
  }
  t = t.replace(/\./g, ":").trim();
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/i);
  if (!m) return { hhmm: null, note };
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]!.toLowerCase();
  if (h > 12 || min > 59) return { hhmm: null, note };
  if (ap === "p" && h !== 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  return { hhmm: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`, note };
}

function addMinutes(hhmm: string, mins: number): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const total = h * 60 + m + mins;
  // A late-evening tour plus 30 minutes stays on the same day in practice;
  // clamp rather than roll over so an event can never start after it ends.
  const capped = Math.min(total, 23 * 60 + 59);
  return `${String(Math.floor(capped / 60)).padStart(2, "0")}:${String(capped % 60).padStart(2, "0")}`;
}

/** Guides are written "Andrew", "Andrew/David", "Harsh Andrew". */
function guideNames(raw: string): string[] {
  return raw
    .split(/[/,&]|\s+and\s+|\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The sheet has no column for it — a virtual tour is only ever mentioned in
 * the notes, so that is where it has to be read from.
 */
const VIRTUAL = /\b(virtual|zoom|facetime|video tour)\b/i;

/**
 * A stable identity for a tour: who, where, which day. Deliberately not the
 * time — a tour moved by an hour is the same tour, and re-keying on time would
 * book a second event every time somebody nudged one.
 *
 * Date is in the key even though it can be edited, because two tours by the
 * same prospect at the same property on different days are genuinely two tours
 * and both need booking — a prospect who tours on the 9th and comes back on
 * the 12th is a real pattern, not a typo. A tour moved to another *day*
 * therefore changes key, and `pairRekeyed` is what stops that looking like a
 * new tour.
 */
function tourKey(name: string, street: string, date: string): string {
  return createHash("sha256")
    .update([name, street, date].map((s) => s.toLowerCase().replace(/\s+/g, " ").trim()).join("|"))
    .digest("hex")
    .slice(0, 32);
}

/**
 * A tours row → the event to create, or null if the row isn't a bookable tour.
 *
 * Blank spacer rows, and rows with no date, are skipped rather than queued:
 * the sheet always carries a few, and an event with no date is not useful to
 * anyone.
 */
export function tourEventFrom(row: any[], columns: any[]): TourEvent | null {
  const idx = columnIndex(columns);
  const name = cell(row, idx, "Name");
  const location = cell(row, idx, "Location");
  const date = cell(row, idx, "Date");
  if (!name || !location || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const street = streetOf(location);
  const notes = cell(row, idx, "Personal Opinion");
  const virtual = VIRTUAL.test(notes);
  const guides = guideNames(cell(row, idx, "Tour Guide"));

  const known = guideEmails();
  const guestSet = new Set(STANDING_GUESTS);
  const unknownGuides: string[] = [];
  for (const g of guides) {
    const email = known[g.toLowerCase()];
    if (email) guestSet.add(email);
    else unknownGuides.push(g);
  }

  const title =
    `${street} ${name} <> ${guides.join(" & ") || "unassigned"}` + (virtual ? " (Virtual)" : "");

  const { hhmm, note: timeNote } = parseTime(cell(row, idx, "Time"));
  const endCell = parseTime(cell(row, idx, "End Time")).hhmm;

  const phone = cell(row, idx, "Phone");
  const lines = [
    `Prospect: ${name}`,
    `Phone: ${phone || "(none on file)"}`,
  ];
  const add = (label: string, value: string) => {
    if (value && !["x", "nil"].includes(value.toLowerCase())) lines.push(`${label}: ${value}`);
  };
  add("Occupation", cell(row, idx, "Career"));
  add("Lease type", cell(row, idx, "Lease Type"));
  add("Source", cell(row, idx, "Source"));
  add("Status", cell(row, idx, "Status"));
  add("Tenancy", cell(row, idx, "Tenancy?"));
  lines.push(`Host: ${guides.join(" & ") || "unassigned"}`);
  lines.push(`Format: ${virtual ? "Virtual tour" : "In person"}`);
  lines.push(`Address: ${fullAddress(street)}`);
  if (timeNote) lines.push(`Time note: ${timeNote}`);
  if (notes) lines.push(`\nNotes: ${notes}`);

  return {
    key: tourKey(name, street, date),
    title,
    location: fullAddress(street),
    description: lines.join("\n"),
    guests: [...guestSet],
    ...(hhmm
      ? { start: `${date} ${hhmm}:00`, end: `${date} ${endCell ?? addMinutes(hhmm, DEFAULT_MINUTES)}:00` }
      : { allDayOn: date }),
    timeZone: TOUR_TIMEZONE,
    virtual,
    unknownGuides,
    identity: { name, street, date },
  };
}

