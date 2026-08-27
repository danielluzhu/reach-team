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

    // An eventId means the tour was edited and the event already exists.
    if (body.eventId) {
      var existing = null;
      try {
        existing = cal.getEventById(body.eventId);
      } catch (lookupErr) {
        existing = null;
      }
      if (existing) {
        updateEvent(existing, ev, tz);
        return reply({ ok: true, id: existing.getId(), updated: true });
      }
      // Somebody deleted it off the calendar. Book it again rather than
      // failing forever on an id that will never come back.
      var replacement = createEvent(cal, ev, tz);
      return reply({ ok: true, id: replacement.getId(), recreated: true });
    }

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
 * Brings an existing event in line with the sheet: time, title, place, notes
 * and who is invited.
 *
 * Guests are reconciled rather than replaced, because removing and re-adding
 * somebody re-sends them an invitation and drops the answer they had already
 * given. Only a guide who is genuinely no longer on the tour is removed.
 */
function updateEvent(event, ev, tz) {
  if (ev.allDayOn) {
    event.setAllDayDate(parseInTz(ev.allDayOn + ' 00:00:00', tz));
  } else {
    event.setTime(parseInTz(ev.start, tz), parseInTz(ev.end, tz));
  }
  event.setTitle(ev.title);
  event.setLocation(ev.location || '');
  event.setDescription(ev.description || '');

  var wanted = {};
  (ev.guests || []).forEach(function (g) { wanted[g.toLowerCase()] = true; });

  var present = {};
  event.getGuestList().forEach(function (guest) {
    var email = guest.getEmail().toLowerCase();
    present[email] = true;
    if (!wanted[email]) event.removeGuest(guest.getEmail());
  });
  (ev.guests || []).forEach(function (g) {
    if (!present[g.toLowerCase()]) event.addGuest(g);
  });
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
