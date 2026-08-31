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

    // This file is public — it lives in the repository — so the placeholder is
    // a known string. Refusing outright while it is still in place means a
    // deployment made by pasting this file is closed rather than open to
    // anyone who has the URL. Re-pasting the file over a working deployment is
    // exactly how that happens, so it must fail loudly, not silently work.
    if (SECRET === 'REPLACE_ME' || SECRET.length < 16) {
      return reply({
        error: 'this deployment still has the placeholder SECRET — set a real one ' +
               '(openssl rand -hex 32) and re-deploy as a New version',
      });
    }

    // Constant-time-ish compare. Apps Script has no timing-safe helper, and the
    // secret is long and random, so a length check plus a full-string compare
    // is the practical limit here.
    if (!body.secret || body.secret.length !== SECRET.length || body.secret !== SECRET) {
      return reply({ error: 'unauthorized' });
    }

    // The whole calendar for a date range, for the CRM's calendar page. This
    // one does list the calendar — that is the point of it — so it returns
    // only what a page needs to draw and caps how much comes back.
    if (body.action === 'agenda') {
      var agendaCal = CalendarApp.getDefaultCalendar();
      var agendaTz = body.timeZone || 'America/Los_Angeles';
      var found = agendaCal.getEvents(
        parseInTz(body.from + ' 00:00:00', agendaTz),
        parseInTz(body.to + ' 23:59:59', agendaTz)
      );
      var agenda = [];
      for (var a = 0; a < found.length && a < 500; a++) {
        var item = found[a];
        var whole = item.isAllDayEvent();
        var guestEmails = [];
        var guestList = item.getGuestList();
        for (var g = 0; g < guestList.length; g++) guestEmails.push(guestList[g].getEmail());
        agenda.push({
          id: item.getId(),
          title: item.getTitle(),
          location: item.getLocation(),
          // Long enough to be useful in a popover, short enough that a busy
          // month doesn't return a megabyte.
          description: (item.getDescription() || '').slice(0, 600),
          allDay: whole,
          start: whole
            ? Utilities.formatDate(item.getAllDayStartDate(), agendaTz, 'yyyy-MM-dd')
            : Utilities.formatDate(item.getStartTime(), agendaTz, 'yyyy-MM-dd HH:mm:ss'),
          end: whole
            ? Utilities.formatDate(item.getAllDayEndDate(), agendaTz, 'yyyy-MM-dd')
            : Utilities.formatDate(item.getEndTime(), agendaTz, 'yyyy-MM-dd HH:mm:ss'),
          guests: guestEmails,
        });
      }
      return reply({ ok: true, calendar: agendaCal.getName(), events: agenda });
    }

    // Reading back what the calendar currently says, so the CRM can pick up
    // an edit a guest made. Ids are asked for explicitly: this never lists
    // the calendar, only the events the CRM itself booked.
    if (body.action === 'read') {
      var cal = CalendarApp.getDefaultCalendar();
      var tz = body.timeZone || 'America/Los_Angeles';
      var out = [];
      var ids = (body.eventIds || []).slice(0, 100);
      for (var i = 0; i < ids.length; i++) {
        var found = null;
        try {
          found = cal.getEventById(ids[i]);
        } catch (readErr) {
          found = null;
        }
        if (!found) {
          out.push({ id: ids[i], missing: true });
          continue;
        }
        var allDay = found.isAllDayEvent();
        out.push({
          id: ids[i],
          title: found.getTitle(),
          location: found.getLocation(),
          allDay: allDay,
          start: allDay
            ? Utilities.formatDate(found.getAllDayStartDate(), tz, 'yyyy-MM-dd')
            : Utilities.formatDate(found.getStartTime(), tz, 'yyyy-MM-dd HH:mm:ss'),
          end: allDay
            ? Utilities.formatDate(found.getAllDayEndDate(), tz, 'yyyy-MM-dd')
            : Utilities.formatDate(found.getEndTime(), tz, 'yyyy-MM-dd HH:mm:ss'),
          updated: found.getLastUpdated().toISOString(),
        });
      }
      return reply({ ok: true, events: out });
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
  var event;
  if (ev.allDayOn) {
    // A tour with a date but no time — booked as all-day rather than guessed at.
    event = cal.createAllDayEvent(ev.title, parseInTz(ev.allDayOn + ' 00:00:00', tz), options);
  } else {
    event = cal.createEvent(ev.title, parseInTz(ev.start, tz), parseInTz(ev.end, tz), options);
  }
  // A guide who reschedules on their phone should not have to also edit the
  // sheet — the CRM reads these changes back.
  event.setGuestsCanModify(true);
  return event;
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
  event.setGuestsCanModify(true);

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
