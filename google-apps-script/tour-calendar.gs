/**
 * Creates a Google Calendar event for a tour, on behalf of the account that
 * deploys this script.
 *
 * This is the copy of record for what is deployed at CALENDAR_WEBHOOK_URL.
 * The CRM (calendar.ts) posts here whenever a new tour is added to the Tours
 * sheet; this runs as the deploying account, so the event is owned by that
 * account and the invitations come from it.
 *
 * ── Deploying ────────────────────────────────────────────────────────────
 *  1. script.google.com → New project, paste this file in, name it
 *     "Tour calendar".
 *  2. Replace SECRET below with a long random string. Generate one with:
 *       openssl rand -hex 32
 *  3. Deploy → New deployment → type "Web app".
 *       Execute as:      Me (the account whose calendar this is)
 *       Who has access:  Anyone
 *     "Anyone" is what lets the CRM reach it without a Google login; SECRET is
 *     what stops anyone else who finds the URL from booking on your calendar.
 *  4. Authorise it when prompted, and copy the /exec URL.
 *  5. On the CRM box, put both values in the service environment:
 *       CALENDAR_WEBHOOK_URL=https://script.google.com/macros/s/…/exec
 *       CALENDAR_WEBHOOK_SECRET=<the same string as SECRET>
 *
 * Re-deploy with "Manage deployments → edit → New version" after any change
 * here, otherwise the old code keeps serving.
 */

var SECRET = 'REPLACE_ME';

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return reply({ error: 'empty request' });
    var body = JSON.parse(e.postData.contents);

    // Constant-time-ish compare. Apps Script has no timing-safe helper, and the
    // secret is long and random, so a length check plus a full-string compare
    // is the practical limit here.
    if (!body.secret || body.secret.length !== SECRET.length || body.secret !== SECRET) {
      return reply({ error: 'unauthorized' });
    }

    var ev = body.event || {};
    if (!ev.title) return reply({ error: 'missing title' });

    var cal = CalendarApp.getDefaultCalendar();
    var tz = ev.timeZone || 'America/Los_Angeles';

    var event = createEvent(cal, ev, tz);
    return reply({ ok: true, id: event.getId() });
  } catch (err) {
    return reply({ error: String(err && err.message ? err.message : err) });
  }
}

function createEvent(cal, ev, tz) {
  var options = {
    description: ev.description || '',
    location: ev.location || '',
    guests: (ev.guests || []).join(','),
    sendInvites: true,
  };
  if (ev.allDayOn) {
    // A tour with a date but no time — booked as all-day rather than guessed at.
    return cal.createAllDayEvent(ev.title, parseInTz(ev.allDayOn + ' 00:00:00', tz), options);
  }
  return cal.createEvent(ev.title, parseInTz(ev.start, tz), parseInTz(ev.end, tz), options);
}

/**
 * "2026-08-23 14:00:00" in the property's zone → a real instant.
 *
 * Parsing in an explicit zone rather than the script's own is what keeps this
 * correct across daylight saving: the CRM sends wall-clock time exactly as it
 * appears on the sheet, and the zone it belongs to, and nothing in between has
 * to agree about the offset.
 */
function parseInTz(stamp, tz) {
  return Utilities.parseDate(stamp, tz, 'yyyy-MM-dd HH:mm:ss');
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/** Run once from the editor to confirm the calendar is reachable and grant scopes. */
function selfTest() {
  Logger.log('Default calendar: ' + CalendarApp.getDefaultCalendar().getName());
  Logger.log('Parsed: ' + parseInTz('2026-08-23 14:00:00', 'America/Los_Angeles'));
}
