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
  // The city is the reliable end of the street line. The separator before it is
  // not reliable at all: the sheet has it with a comma, with just a space, and
  // — from at least one paste — with nothing at all ("54th StSeattle, WA"). So
  // the separator is optional, and a match that would leave nothing behind is
  // ignored, which protects a street that has the city in its own name.
  if (city) {
    const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const head = s.split(new RegExp(`,?\\s*${escaped}\\b`, "i"))[0]!.trim();
    // A street line is a number and at least one name word. Anything shorter
    // means the city name is part of the street itself ("123 Seattle Blvd"),
    // and cutting there would throw the address away.
    if (head.split(/\s+/).filter(Boolean).length >= 2) s = head;
  } else {
    s = s.split(",")[0]!;
  }
  return s.trim().replace(/[,\s]+$/, "");
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
 * The part of the street line that goes in an event title: the number, plus a
 * unit when there is one. "4544 20th Ave NE" → "4544";
 * "121 12th Ave E Unit 310" → "121 #310"; "4735 22nd Ave NE # 4" → "4735 #4".
 *
 * A title is read in a crowded day view, where the number is the whole of what
 * distinguishes one property from another — the rest is nine wasted characters.
 * It also sidesteps how the sheet capitalises: "4544 20th ave ne" and
 * "4544 20TH AVE NE" both come out as "4544".
 *
 * A location with no leading number keeps its whole street line, since there is
 * nothing shorter to say about it.
 */
export function streetLabel(street: string): string {
  const number = street.match(/^(\d+[A-Za-z]?)\b/);
  const unit = street.match(/(?:#|\bUnit\b|\bApt\b|\bSte\b)\s*([A-Za-z0-9][A-Za-z0-9-]*)/i);
  const base = number ? number[1]! : street;
  return unit ? `${base} #${unit[1]}` : base;
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
 * Everything written into a description is escaped, because the description is
 * HTML and the values come out of a spreadsheet. A note reading "Wants a 3-bed
 * & parking <before Sept>" must not be able to break the markup — or inject
 * any.
 */
function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type PhoneEntry = { display: string; e164: string | null; label: string | null };

/**
 * The numbers in one Phone cell, each with a dialable form.
 *
 * The column holds a dozen shapes — "(425) 765-2455", "5415257433",
 * "+86 186 0026 2057", two numbers split by a slash, and a few with the
 * person's name in brackets after them. All of that is somebody's real contact
 * detail, so the original text is always kept; the normalised form is only
 * used for the link.
 *
 * A number that can't be made sense of gets no link rather than a broken one:
 * a tel: that dials nothing is worse than a number you have to copy.
 */
export function phoneEntries(raw: string): PhoneEntry[] {
  return raw
    .split(/[/\n;]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      // A trailing "(Wendy)" names whose number it is; "(425)" is an area code.
      const named = part.match(/\(([A-Za-z][^)]*)\)\s*$/);
      const label = named ? named[1]!.trim() : null;
      const display = part;
      const body = named ? part.slice(0, named.index).trim() : part;

      const plus = body.trim().startsWith("+");
      const digits = body.replace(/\D/g, "");
      let e164: string | null = null;
      if (plus && digits.length >= 8) e164 = `+${digits}`;
      else if (digits.length === 10) e164 = `+1${digits}`;
      else if (digits.length === 11 && digits.startsWith("1")) e164 = `+${digits}`;
      return { display, e164, label };
    });
}

/**
 * The contact lines for an event description: the number as written, then a
 * real link to call it and a real link to text it.
 *
 * They are anchors rather than bare `tel:` text because the person reading
 * this is standing outside a building holding a phone — one press should open
 * the dialler or the messages app, not select a string to copy. Google
 * Calendar renders a subset of HTML in descriptions, which is what makes that
 * possible; each link says in words which one it is, since an icon alone is
 * ambiguous and the two actions are not interchangeable.
 */
export function contactLines(raw: string): string[] {
  const phone = raw.trim();
  if (!phone) return ["Phone: (none on file)"];

  const entries = phoneEntries(phone);
  const lines = [`Phone: ${esc(phone)}`];
  for (const entry of entries) {
    if (!entry.e164) continue;
    const who = entry.label
      ? ` ${esc(entry.label)}`
      : entries.length > 1
        ? ` ${esc(entry.display)}`
        : "";
    lines.push(
      `<a href="tel:${esc(entry.e164)}">Call${who}</a>` +
        ` &nbsp;|&nbsp; ` +
        `<a href="sms:${esc(entry.e164)}">Text${who}</a>`
    );
  }
  return lines;
}

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
    `${streetLabel(street)} ${name} <> ${guides.join(" & ") || "unassigned"}` +
    (virtual ? " (Virtual)" : "");

  const { hhmm, note: timeNote } = parseTime(cell(row, idx, "Time"));
  const endCell = parseTime(cell(row, idx, "End Time")).hhmm;

  const phone = cell(row, idx, "Phone");
  const lines = [`Prospect: ${esc(name)}`, ...contactLines(phone)];
  const add = (label: string, value: string) => {
    if (value && !["x", "nil"].includes(value.toLowerCase())) {
      lines.push(`${label}: ${esc(value)}`);
    }
  };
  add("Occupation", cell(row, idx, "Career"));
  add("Lease type", cell(row, idx, "Lease Type"));
  add("Source", cell(row, idx, "Source"));
  add("Status", cell(row, idx, "Status"));
  add("Tenancy", cell(row, idx, "Tenancy?"));
  lines.push(`Host: ${esc(guides.join(" & ") || "unassigned")}`);
  lines.push(`Format: ${virtual ? "Virtual tour" : "In person"}`);
  lines.push(`Address: ${esc(fullAddress(street))}`);
  if (timeNote) lines.push(`Time note: ${esc(timeNote)}`);
  if (notes) lines.push(`<br>Notes: ${esc(notes)}`);

  return {
    key: tourKey(name, street, date),
    title,
    location: fullAddress(street),
    description: lines.join("<br>"),
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

const insertEvent = db.prepare(
  `INSERT OR IGNORE INTO tour_events
     (key, title, starts_at, payload, payload_sig, added_by, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const readEvent = db.prepare(`SELECT * FROM tour_events WHERE key = ?`);
/**
 * Re-queues an existing row with new details. `event_id` is left alone: it is
 * what tells flushQueue to update the event that already exists rather than
 * book another one, and `attempts` is reset so a row that had given up gets a
 * fresh run at it.
 */
const updateEventRow = db.prepare(
  `UPDATE tour_events
     SET title = ?, starts_at = ?, payload = ?, payload_sig = ?,
         state = 'pending', attempts = 0, last_error = NULL
   WHERE key = ?`
);
/** Moves a queue row onto the new key when the tour's identity was edited. */
const rekeyEvent = db.prepare(`UPDATE tour_events SET key = ? WHERE key = ?`);

type QueueRow = { key: string; payload_sig: string; state: string; event_id: string | null };

/** How many of {prospect, property, date} two tours must share to be the same tour. */
const REKEY_MIN_MATCHES = 2;

/**
 * Pairs a tour that appeared in this save with one that vanished in it.
 *
 * Editing the prospect, the property or the date changes the key, so the same
 * tour looks like one row disappearing and an unrelated one arriving. Both
 * sides of that are visible in a single save, which is what makes the pairing
 * possible at all: a vanished tour that agrees with an arrived tour on two of
 * the three identity fields is that tour, moved.
 *
 * Only rows that actually vanished are candidates, which is what keeps a
 * genuine re-tour safe — when a prospect tours again a few days later, the
 * earlier row is still on the sheet, so there is nothing to pair with and the
 * second tour books its own event.
 */
function pairRekeyed(
  addedKeys: string[],
  removed: Map<string, TourEvent>,
  events: Map<string, TourEvent>
): Map<string, string> {
  const pairs = new Map<string, string>();
  const taken = new Set<string>();
  for (const newKey of addedKeys) {
    const now = events.get(newKey)!;
    let best: { key: string; score: number } | undefined;
    for (const [oldKey, was] of removed) {
      if (taken.has(oldKey)) continue;
      const score =
        Number(was.identity.name.toLowerCase() === now.identity.name.toLowerCase()) +
        Number(was.identity.street.toLowerCase() === now.identity.street.toLowerCase()) +
        Number(was.identity.date === now.identity.date);
      if (score >= REKEY_MIN_MATCHES && (!best || score > best.score)) best = { key: oldKey, score };
    }
    if (best) {
      pairs.set(newKey, best.key);
      taken.add(best.key);
    }
  }
  return pairs;
}

/**
 * Of the rows sharing one key, the one whose details should be on the calendar.
 *
 * Two rows can share a key: somebody re-tours the same prospect at the same
 * property on the same day and adds a second line with the new time rather
 * than editing the first. The later entry is the one that is meant to happen,
 * so a row that wasn't on the sheet before this save wins over one that was.
 */
function chooseRow(rows: { event: TourEvent; wasThereBefore: boolean }[]): TourEvent {
  const fresh = rows.filter((r) => !r.wasThereBefore);
  return (fresh.length ? fresh[fresh.length - 1]! : rows[rows.length - 1]!).event;
}

export type EnqueueResult = {
  /** Tours booked for the first time. */
  created: TourEvent[];
  /** Tours whose event already exists and is being brought up to date. */
  updated: TourEvent[];
  /** Tours that left the sheet and whose events were left alone. */
  vanished: TourEvent[];
};

/**
 * Works out what this save did to the tours sheet, and queues the calendar
 * work it implies: book the new ones, update the edited ones, and say so when
 * one disappeared.
 *
 * The comparison is by tour identity, never by row index — the sheets API
 * sends the whole sheet on every save and rows are re-sorted and inserted
 * above one another constantly.
 */
export function enqueueNewTours(
  before: any[][],
  after: any[][],
  columns: any[],
  addedBy: string
): EnqueueResult {
  const beforeRowJson = new Set(before.map((r) => JSON.stringify(r)));

  const beforeKeys = new Map<string, TourEvent>();
  for (const row of before) {
    const e = tourEventFrom(row, columns);
    if (e) beforeKeys.set(e.key, e);
  }

  // Group the sheet as it stands now by key, so duplicate lines for one tour
  // resolve to a single event before anything is queued.
  const grouped = new Map<string, { event: TourEvent; wasThereBefore: boolean }[]>();
  for (const row of after) {
    const e = tourEventFrom(row, columns);
    if (!e) continue;
    const bucket = grouped.get(e.key) ?? [];
    bucket.push({ event: e, wasThereBefore: beforeRowJson.has(JSON.stringify(row)) });
    grouped.set(e.key, bucket);
  }
  const events = new Map<string, TourEvent>();
  for (const [key, rows] of grouped) events.set(key, chooseRow(rows));

  const addedKeys = [...events.keys()].filter((k) => !beforeKeys.has(k));
  const removed = new Map([...beforeKeys].filter(([k]) => !events.has(k)));
  const rekeyed = pairRekeyed(addedKeys, removed, events);

  const result: EnqueueResult = { created: [], updated: [], vanished: [] };
  const now = new Date().toISOString();

  for (const [key, e] of events) {
    const payload = JSON.stringify(e);
    const sig = createHash("sha256").update(payload).digest("hex").slice(0, 16);
    const startsAt = e.start ?? e.allDayOn ?? "";

    // The tour was edited in a way that changed its key. Move the existing
    // queue row onto the new key first, so what follows treats it as the
    // update it is instead of booking a second event.
    const oldKey = rekeyed.get(key);
    if (oldKey && readEvent.get(oldKey)) {
      rekeyEvent.run(key, oldKey);
      removed.delete(oldKey);
    }

    const existing = readEvent.get(key) as QueueRow | undefined;
    if (!existing) {
      // A tour with no queue row that was *already on the sheet* before this
      // save predates the feature — the sheet holds months of them. Booking
      // those here would fire an invitation for every historic tour the first
      // time somebody typed anything. They are `calendar backfill`'s job.
      if (beforeKeys.has(key)) continue;
      insertEvent.run(key, e.title, startsAt, payload, sig, addedBy, now);
      result.created.push(e);
      continue;
    }
    if (existing.payload_sig === sig) continue;

    // Same tour, different details. Whether the event exists yet decides what
    // happens: if it does, flushQueue will edit it in place; if it is still
    // waiting to be created, this simply corrects what will be sent.
    updateEventRow.run(e.title, startsAt, payload, sig, key);
    if (existing.event_id) result.updated.push(e);
  }

  // A tour that left the sheet keeps its event. Deleting somebody else's
  // meeting because a row was removed — or because a page saved a stale copy —
  // is not a call this should make on its own.
  for (const e of removed.values()) result.vanished.push(e);

  return result;
}

export function calendarConfigured(): boolean {
  return Boolean(WEBHOOK_URL && WEBHOOK_SECRET);
}

const claimPending = db.prepare(
  `SELECT key, payload, attempts, event_id FROM tour_events
   WHERE state = 'pending' AND attempts < ? ORDER BY created_at LIMIT ?`
);
/** One named row, for a self-test that must not post anybody else's tour. */
const claimOne = db.prepare(
  `SELECT key, payload, attempts, event_id FROM tour_events
   WHERE state = 'pending' AND attempts < ? AND key = ?`
);
const markSent = db.prepare(
  `UPDATE tour_events SET state = 'sent', event_id = ?, event_url = ?,
     sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE key = ?`
);
const markThrottled = db.prepare(
  `UPDATE tour_events SET last_error = ? WHERE key = ?`
);
const markFailed = db.prepare(
  `UPDATE tour_events SET state = ?, attempts = attempts + 1, last_error = ? WHERE key = ?`
);

/** Give up after this many tries and leave the row for a human to look at. */
const MAX_ATTEMPTS = 6;

/**
 * A pause between posts.
 *
 * Google throttles bursts — "you have been creating or deleting too many
 * calendar events in a short time" — which a backfill or a bulk re-send walks
 * straight into. The retry loop recovers from it, but a rejected write is
 * still a write that had to happen twice, and a queue that trips the limit on
 * every pass makes a slow job slower. A short gap costs nothing on the
 * one-event case that is almost always what this is doing.
 */
const BETWEEN_POSTS_MS = 400;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Posts whatever is queued to the Apps Script, one at a time.
 *
 * Errors are recorded and retried, not thrown: this runs detached from the
 * request that caused it, and there is nobody left to tell. A row that has
 * failed MAX_ATTEMPTS times moves to 'failed' so it stops being retried every
 * thirty seconds forever — `bun run calendar retry` puts it back.
 */
export async function flushQueue(limit = 10, onlyKey?: string): Promise<void> {
  if (!calendarConfigured()) return;
  const pending = (onlyKey ? claimOne.all(MAX_ATTEMPTS, onlyKey) : claimPending.all(MAX_ATTEMPTS, limit)) as {
    key: string;
    payload: string;
    attempts: number;
    event_id: string | null;
  }[];

  let first = true;
  for (const row of pending) {
    if (!first) await pause(BETWEEN_POSTS_MS);
    first = false;
    const event = JSON.parse(row.payload) as TourEvent;
    // An id means the event is already on the calendar and this is an edit.
    const updating = Boolean(row.event_id);
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: WEBHOOK_SECRET, event, eventId: row.event_id ?? null }),
        signal: AbortSignal.timeout(20_000),
      });
      const text = await res.text();
      let body: any = {};
      try {
        body = JSON.parse(text);
      } catch {
        // Apps Script serves an HTML error page when a deployment is wrong,
        // which is the single most common way this is misconfigured.
        throw new Error(
          `non-JSON reply (HTTP ${res.status}) — check the deployment is "Anyone" ` +
            `and the URL ends in /exec: ${text.slice(0, 120)}`
        );
      }
      if (!res.ok || !body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);

      markSent.run(body.id ?? row.event_id, body.url ?? null, new Date().toISOString(), row.key);
      console.log(
        `[${new Date().toISOString()}] calendar event ` +
          `${updating ? (body.recreated ? "re-created (it had been deleted)" : "updated") : "created"}: ` +
          `"${event.title}" ${event.start ?? `${event.allDayOn} (all day)`} ` +
          `→ ${event.guests.join(", ")}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Being throttled says nothing about this event — it says the last few
      // succeeded. Counting it toward the give-up limit would let a busy
      // minute permanently fail a tour that was never wrong.
      const throttled = /too many calendar|rate limit|quota|try again later/i.test(message);
      if (throttled) {
        markThrottled.run(message, row.key);
        console.warn(
          `[${new Date().toISOString()}] calendar throttled on "${event.title}" — ` +
            `will retry, attempt not counted`
        );
        await pause(2_000);
        continue;
      }
      const done = row.attempts + 1 >= MAX_ATTEMPTS;
      markFailed.run(done ? "failed" : "pending", message, row.key);
      console.error(
        `[${new Date().toISOString()}] calendar ${updating ? "update" : "booking"} failed ` +
          `(attempt ${row.attempts + 1}${done ? ", giving up" : ""}) for "${event.title}": ${message}`
      );
    }
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Starts the retry loop. Saves kick a flush off immediately, so this only
 * exists to pick up anything that failed while Google was unreachable.
 */
export function startCalendarWorker() {
  if (timer) return;
  if (!calendarConfigured()) {
    console.log(
      "Calendar events: off (set CALENDAR_WEBHOOK_URL and CALENDAR_WEBHOOK_SECRET to " +
        "enable — see google-apps-script/tour-calendar.gs)"
    );
    return;
  }
  const stuck = db
    .query(`SELECT COUNT(*) AS n FROM tour_events WHERE state = 'pending'`)
    .get() as { n: number };
  console.log(
    `Calendar events: on, inviting ${STANDING_GUESTS.join(", ")} plus the tour guide` +
      (stuck.n ? ` (${stuck.n} queued from earlier)` : "")
  );
  timer = setInterval(() => void flushQueue(), 30_000);
  // Reading every event back is a heavier call than sending, and a guest's
  // edit is not urgent — two minutes is soon enough, and it keeps well inside
  // Apps Script's daily execution budget.
  pollTimer = setInterval(() => {
    void pollCalendarChanges().catch((err) =>
      console.error(`[${new Date().toISOString()}] reading calendar edits failed:`, err.message)
    );
  }, 120_000);
  // Don't hold the process open just for the background loops.
  timer.unref?.();
  pollTimer.unref?.();
  void flushQueue();
}

/* ────────────────────────────────────────────────────────────────────────
 * Calendar → sheet
 *
 * Guests can edit these events, so the calendar can be ahead of the sheet: a
 * guide who moves a tour on their phone should not have to type it twice.
 *
 * This polls rather than being pushed to. The CRM is on the public internet
 * behind a sign-in and everything it holds is tenant data, so a new endpoint
 * that Google could POST into is a worse trade than a couple of minutes of
 * delay — and polling reuses the one secret that already exists instead of
 * opening a second way in.
 *
 * Only when/where is read back. Title and description are derived from the
 * sheet and would be circular; who is invited belongs to the guide map.
 * ──────────────────────────────────────────────────────────────────────── */

type RemoteEvent = {
  id: string;
  title?: string;
  location?: string;
  allDay?: boolean;
  start?: string;
  end?: string;
  updated?: string;
  missing?: boolean;
};

const sentEvents = db.prepare(
  `SELECT key, title, payload, event_id FROM tour_events
   WHERE state = 'sent' AND event_id IS NOT NULL AND key NOT LIKE 'selftest%'`
);
const setPayload = db.prepare(
  `UPDATE tour_events SET title = ?, starts_at = ?, payload = ?, payload_sig = ? WHERE key = ?`
);

/** "14:30" → "2:30PM", which is how the sheet's own rows are written. */
function sheetTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const ampm = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")}${ampm}`;
}

/**
 * Asks the calendar what these events say now.
 *
 * A batch at a time, because Apps Script has a six-minute ceiling on a single
 * execution and reading a hundred events is already most of a second each.
 */
async function readRemote(ids: string[]): Promise<Map<string, RemoteEvent>> {
  const out = new Map<string, RemoteEvent>();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: WEBHOOK_SECRET,
        action: "read",
        eventIds: batch,
        timeZone: TOUR_TIMEZONE,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON reply reading events: ${text.slice(0, 120)}`);
    }
    if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    for (const e of body.events as RemoteEvent[]) out.set(e.id, e);
  }
  return out;
}

const requeueAll = db.prepare(
  `UPDATE tour_events SET state = 'pending', attempts = 0, last_error = NULL
   WHERE state = 'sent' AND event_id IS NOT NULL`
);

/**
 * Re-sends every event that already exists, unchanged.
 *
 * Normally an event is only touched when its tour changed, which is right —
 * but a setting that lives on the Google side (who may edit it, say) can only
 * be applied by writing the event again. This is how a change to the Apps
 * Script reaches events that were booked before it.
 */
export function requeueSentEvents(): number {
  return requeueAll.run().changes;
}

export type Check = { name: string; ok: boolean; detail: string };

/**
 * What the deployed Apps Script can actually do right now.
 *
 * The script gains actions over time but a deployment serves whatever version
 * was published, so "the code is right" and "the thing answering is right" are
 * different questions — and the second one is the one that breaks. An action
 * the deployment doesn't know falls through to the booking path and answers
 * "missing title", which is a confusing thing to meet on a calendar page, so
 * this asks each one directly and says which are live.
 *
 * Nothing here writes: the booking probe deliberately sends an event with no
 * title, which is rejected before anything is created.
 */
export async function checkDeployment(): Promise<Check[]> {
  const checks: Check[] = [];
  if (!calendarConfigured()) {
    return [
      {
        name: "configuration",
        ok: false,
        detail: "CALENDAR_WEBHOOK_URL / CALENDAR_WEBHOOK_SECRET are not both set in .env",
      },
    ];
  }
  checks.push({ name: "configuration", ok: true, detail: WEBHOOK_URL });

  const ask = async (payload: Record<string, unknown>): Promise<any> => {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(45_000),
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${res.status}, and not JSON: ${text.slice(0, 90)}`);
    }
  };

  try {
    const wrong = await ask({ secret: "deliberately-wrong", event: { title: "x" } });
    checks.push({
      name: "reachable",
      ok: true,
      detail: "the deployment answers, and is readable without a Google login",
    });
    checks.push({
      name: "secret",
      ok: wrong.error === "unauthorized",
      detail:
        wrong.error === "unauthorized"
          ? "a wrong secret is refused, as it should be"
          : `a wrong secret was NOT refused (got ${JSON.stringify(wrong).slice(0, 60)})`,
    });
  } catch (err) {
    checks.push({
      name: "reachable",
      ok: false,
      detail: `${err instanceof Error ? err.message : err} — check the deployment is "Anyone" and the URL ends /exec`,
    });
    return checks;
  }

  const booking = await ask({ secret: WEBHOOK_SECRET, event: {} }).catch((e) => ({ error: String(e) }));
  checks.push({
    name: "booking events",
    ok: booking.error === "missing title",
    detail:
      booking.error === "missing title"
        ? "live — the secret is accepted and events can be created"
        : `unexpected reply: ${JSON.stringify(booking).slice(0, 80)}`,
  });

  for (const [name, payload] of [
    ["reading guest edits", { action: "read", eventIds: [] }],
    ["listing the calendar", { action: "agenda", from: "2000-01-01", to: "2000-01-01" }],
  ] as const) {
    const reply = await ask({ secret: WEBHOOK_SECRET, ...payload, timeZone: TOUR_TIMEZONE }).catch(
      (e) => ({ error: String(e) })
    );
    checks.push({
      name,
      ok: reply.ok === true,
      detail:
        reply.ok === true
          ? "live"
          : reply.error === "missing title"
            ? "the deployment is serving a version older than this action"
            : `failed: ${JSON.stringify(reply).slice(0, 80)}`,
    });
  }
  return checks;
}

export type CalendarChange = {
  key: string;
  title: string;
  /** Sheet column name → [what the sheet said, what the calendar says]. */
  fields: Record<string, [string, string]>;
};

/**
 * Pulls guest edits back into the tours sheet.
 *
 * Writing straight to the sheets table rather than through the API is
 * deliberate: this is a background job with no page and no `rev` of its own,
 * and the version row it records is what makes the change visible and
 * reversible. A page that was open at the old rev will be told it is stale on
 * its next save, which is the behaviour the sheet already has for every other
 * concurrent edit.
 */
export async function pollCalendarChanges(): Promise<CalendarChange[]> {
  if (!calendarConfigured()) return [];
  const rows = sentEvents.all() as {
    key: string;
    title: string;
    payload: string;
    event_id: string;
  }[];
  if (!rows.length) return [];

  const remote = await readRemote(rows.map((r) => r.event_id));

  const sheet = db.query(`SELECT columns, rows, rev FROM sheets WHERE id = 'tours'`).get() as
    | { columns: string; rows: string; rev: number }
    | undefined;
  if (!sheet) return [];
  const columns = JSON.parse(sheet.columns) as any[];
  const sheetRows = JSON.parse(sheet.rows) as any[][];
  const idx: Record<string, number> = {};
  columns.forEach((c, i) => {
    if (c?.name) idx[String(c.name).trim().toLowerCase()] = i;
  });

  const changes: CalendarChange[] = [];
  let touched = false;

  for (const row of rows) {
    const stored = JSON.parse(row.payload) as TourEvent;
    const got = remote.get(row.event_id);
    if (!got || got.missing) continue;

    // What the calendar says, in the sheet's own vocabulary.
    const wants: Record<string, string> = {};
    if (got.allDay) {
      if (got.start) wants["date"] = got.start;
    } else if (got.start && got.end) {
      const [date, time] = got.start.split(" ");
      wants["date"] = date!;
      wants["time"] = sheetTime(time!.slice(0, 5));
      wants["end time"] = sheetTime(got.end.split(" ")[1]!.slice(0, 5));
    }

    // Compare against what this event was last built from, not against the
    // sheet: that way a change made in the sheet and already pushed out is
    // never mistaken for a change made on the calendar.
    const had: Record<string, string> = {};
    if (stored.allDayOn) had["date"] = stored.allDayOn;
    else if (stored.start && stored.end) {
      had["date"] = stored.start.split(" ")[0]!;
      had["time"] = sheetTime(stored.start.split(" ")[1]!.slice(0, 5));
      had["end time"] = sheetTime(stored.end.split(" ")[1]!.slice(0, 5));
    }

    const differing = Object.keys(wants).filter((k) => wants[k] !== had[k]);
    if (!differing.length) continue;

    // The sheet row this event came from, found by the identity it was booked
    // under rather than by position.
    const target = sheetRows.find((r) => {
      const e = tourEventFrom(r, columns);
      return (
        e &&
        e.identity.name.toLowerCase() === stored.identity.name.toLowerCase() &&
        e.identity.date === stored.identity.date
      );
    });
    if (!target) {
      console.log(
        `[${new Date().toISOString()}] calendar edit to "${row.title}" has no matching ` +
          `sheet row any more; the sheet was left alone`
      );
      continue;
    }

    const fields: Record<string, [string, string]> = {};
    for (const col of differing) {
      const at = idx[col];
      if (at === undefined) continue;
      fields[col] = [String(target[at] ?? ""), wants[col]!];
      target[at] = wants[col];
    }
    if (!Object.keys(fields).length) continue;

    // Re-derive the event from the row as it now reads, and store that as the
    // last-known state. Without this the next save would see a difference and
    // push the guest's own edit straight back at them.
    const rebuilt = tourEventFrom(target, columns);
    if (rebuilt) {
      const payload = JSON.stringify(rebuilt);
      setPayload.run(
        rebuilt.title,
        rebuilt.start ?? rebuilt.allDayOn ?? "",
        payload,
        createHash("sha256").update(payload).digest("hex").slice(0, 16),
        row.key
      );
      if (rebuilt.key !== row.key) db.run(`UPDATE tour_events SET key = ? WHERE key = ?`, [rebuilt.key, row.key]);
    }
    changes.push({ key: row.key, title: row.title, fields });
    touched = true;
  }

  if (touched) {
    const json = JSON.stringify(sheetRows);
    db.run(
      `UPDATE sheets SET rows = ?, rev = rev + 1, updated_at = CURRENT_TIMESTAMP WHERE id = 'tours'`,
      [json]
    );
    const rev = (db.query(`SELECT rev FROM sheets WHERE id = 'tours'`).get() as { rev: number }).rev;
    db.run(
      `INSERT INTO sheet_versions (sheet_id, rev, columns, rows, row_count, saved_by)
       VALUES ('tours', ?, ?, ?, ?, 'google-calendar')`,
      [rev, sheet.columns, json, sheetRows.length]
    );
    for (const c of changes) {
      const what = Object.entries(c.fields)
        .map(([f, [was, now]]) => `${f}: ${was || "(blank)"} → ${now}`)
        .join(", ");
      console.log(
        `[${new Date().toISOString()}] calendar edit pulled into the sheet for "${c.title}" — ${what}`
      );
    }
  }
  return changes;
}

export type AgendaEvent = {
  id: string;
  title: string;
  location?: string;
  description?: string;
  allDay?: boolean;
  start: string;
  end: string;
  guests?: string[];
};

/**
 * The calendar itself, for a date range.
 *
 * This is the only call that lists the calendar rather than asking about ids
 * the CRM already holds — the calendar page needs everything on it, including
 * events nobody booked through here.
 *
 * Nothing is cached. The page is meant to show what the calendar says at the
 * moment it is opened, and a cache is exactly the thing that would make it
 * quietly wrong after somebody moved a tour on their phone.
 */
export async function fetchAgenda(
  from: string,
  to: string
): Promise<{ calendar: string; events: AgendaEvent[] }> {
  if (!calendarConfigured()) throw new Error("not-configured");
  const res = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: WEBHOOK_SECRET,
      action: "agenda",
      from,
      to,
      timeZone: TOUR_TIMEZONE,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `non-JSON reply (HTTP ${res.status}) — the deployment may be serving an older ` +
        `version of the script: ${text.slice(0, 120)}`
    );
  }
  // An older deployment doesn't know this action and falls through to the
  // booking path, which complains about a missing title. Say what that means
  // rather than showing somebody "missing title" on a calendar page.
  if (body.error === "missing title") throw new Error("old-deployment");
  if (!body.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return { calendar: body.calendar ?? "", events: body.events ?? [] };
}
