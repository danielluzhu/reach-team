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

