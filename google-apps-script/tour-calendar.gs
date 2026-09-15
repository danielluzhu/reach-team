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
 *  3. Services (+) in the left-hand bar → Google Calendar API, identifier
 *     "Calendar". A Google Meet link is a conference, and conferences exist
 *     only in the Calendar API — CalendarApp on its own cannot make one, so
 *     without this step virtual tours are booked with no way to join them.
 *  4. Deploy → New deployment → type "Web app".
 *       Execute as:      Me (the account whose calendar this is)
 *       Who has access:  Anyone
 *     "Anyone" is what lets the CRM reach it without a Google login; SECRET is
 *     what stops anyone else who finds the URL from booking on your calendar.
 *  5. Authorise it when prompted, and copy the /exec URL.
 *  6. On the CRM box, put both values in the service environment:
 *       CALENDAR_WEBHOOK_URL=https://script.google.com/macros/s/…/exec
 *       CALENDAR_WEBHOOK_SECRET=<the same string as SECRET>
 *
 * Re-deploy with "Manage deployments → edit → New version" after any change
 * here, otherwise the old code keeps serving.
 */

var SECRET = 'REPLACE_ME';

/**
 * Which calendar the tours live on.
 *
 * Leave blank to use the deploying account's own default calendar. Set it to
 * an address — 'office@example.com' — to put tours somewhere shared instead.
 *
 * Worth being deliberate about: the default calendar is whichever one belongs
 * to the account that pressed Deploy, which is easily somebody's personal
 * calendar. Tours then land among their private events, and anything reading
 * the calendar back reads those too.
 *
 * For an address other than the deploying account's own, that account needs
 * "Make changes to events" on it, shared from Google Calendar's settings.
 */
var CALENDAR_ID = '';

function targetCalendar() {
  if (!CALENDAR_ID) return CalendarApp.getDefaultCalendar();
  var found = CalendarApp.getCalendarById(CALENDAR_ID);
  if (!found) {
    throw new Error(
      'CALENDAR_ID ' + CALENDAR_ID + ' is not a calendar this account can open — ' +
      'share it with "Make changes to events" first'
    );
  }
  return found;
}

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
      var agendaCal = targetCalendar();
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
          // Who put it on the calendar. For anything nobody is invited to and
          // no name appears in — an inspection, say — this is the only record
          // of whose job it is.
          creators: item.getCreators(),
        });
      }
      return reply({ ok: true, calendar: agendaCal.getName(), events: agenda });
    }

    // Reading back what the calendar currently says, so the CRM can pick up
    // an edit a guest made. Ids are asked for explicitly: this never lists
    // the calendar, only the events the CRM itself booked.
    if (body.action === 'read') {
      var cal = targetCalendar();
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

    var cal = targetCalendar();
    var tz = ev.timeZone || 'America/Los_Angeles';

    // One booking at a time, so two posts about the same tour can't both look,
    // both find nothing, and both create an event. The CRM gives up waiting
    // long before this does, and a post it gave up on is exactly the one that
    // comes back — see `bookedId`.
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(45000);
    } catch (lockErr) {
      return reply({ error: 'another booking is still running — try again' });
    }
    try {
      // An id means the event already exists: the CRM has one for a tour it has
      // booked before, and `bookedId` has one for a tour whose booking this
      // script finished after the CRM had stopped listening.
      var eventId = body.eventId || bookedId(ev.key);
      if (eventId) {
        var existing = null;
        try {
          existing = cal.getEventById(eventId);
        } catch (lookupErr) {
          existing = null;
        }
        if (existing) {
          updateEvent(existing, ev, tz);
          remember(ev.key, existing, ev);
          return reply(withMeet(cal, ev, existing, { ok: true, id: existing.getId(), updated: true }));
        }
        // Somebody deleted it off the calendar. Book it again rather than
        // failing forever on an id that will never come back.
        var replacement = createEvent(cal, ev, tz);
        remember(ev.key, replacement, ev);
        return reply(withMeet(cal, ev, replacement, { ok: true, id: replacement.getId(), recreated: true }));
      }

      var event = createEvent(cal, ev, tz);
      // Before the reply, because it is the reply that gets lost.
      remember(ev.key, event, ev);
      return reply(withMeet(cal, ev, event, { ok: true, id: event.getId() }));
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return reply({ error: String(err && err.message ? err.message : err) });
  }
}

/**
 * What this script has already booked, so it never books it twice.
 *
 * Creating an event takes Apps Script a few seconds, and sometimes a great deal
 * longer than that — a cold start, a slow Calendar call — while the CRM waits a
 * fixed number of seconds for the reply and then treats the post as failed and
 * sends it again. The event was made; only the answer was lost. Every retry
 * made another one, and a prospect had nine identical invitations to the same
 * tour.
 *
 * So the id is written down here, against the tour's own key, the moment the
 * event exists. A post that comes back for a tour already in this list updates
 * that event instead of booking another.
 *
 * Script properties are shared by every execution of the script and outlive all
 * of them, which is what makes this work at all. They are also capped, so the
 * list is trimmed of tours long past when it gets big.
 */
function bookedId(key) {
  if (!key) return '';
  try {
    var stored = PropertiesService.getScriptProperties().getProperty('tour:' + key);
    return stored ? String(stored).split('|')[0] : '';
  } catch (err) {
    // A booking is worth more than a perfect record of one.
    return '';
  }
}

function remember(key, event, ev) {
  if (!key) return;
  try {
    var props = PropertiesService.getScriptProperties();
    // The tour's day rides along so the list can be trimmed later; an id says
    // nothing about when it was for.
    var day = String(ev.start || ev.allDayOn || '').slice(0, 10);
    props.setProperty('tour:' + key, event.getId() + '|' + day);
    forgetOldTours(props);
  } catch (err) {
    // Same again: the event is booked, and the next post will find it by the id
    // the CRM holds even if this didn't get written.
  }
}

/** Tours whose day is long gone can't be posted about again. */
var KEEP_TOURS = 400;
var KEEP_DAYS = 120;

function forgetOldTours(props) {
  var all = props.getProperties();
  var keys = Object.keys(all);
  if (keys.length < KEEP_TOURS) return;
  var cutoff = Utilities.formatDate(
    new Date(Date.now() - KEEP_DAYS * 86400000),
    'Etc/UTC',
    'yyyy-MM-dd'
  );
  for (var i = 0; i < keys.length; i++) {
    if (keys[i].indexOf('tour:') !== 0) continue;
    var day = String(all[keys[i]]).split('|')[1];
    if (day && day < cutoff) props.deleteProperty(keys[i]);
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
 * A virtual tour needs somewhere to happen, and for a video tour that is a
 * Google Meet link on the invitation the prospect already has.
 *
 * The reply carries the link, or the reason there isn't one — a missing
 * Calendar service is the likely one, and it is a mistake in the deployment
 * rather than in the tour. Either way the event itself is booked and correct,
 * so this never turns a working booking into a failed one; the CRM logs what
 * came back.
 */
function withMeet(cal, ev, event, out) {
  if (!ev.virtual) return out;
  try {
    out.meet = ensureMeet(cal, event);
  } catch (err) {
    out.meetError = String(err && err.message ? err.message : err);
  }
  return out;
}

/**
 * The Meet link on an event, adding one if it hasn't got one.
 *
 * Through the advanced Calendar service, because a conference is not something
 * CalendarApp can create — see step 3 of the deployment notes above. An event
 * that already has a conference is left exactly as it is: asking for another
 * would hand everybody a second link and silently strand whoever kept the
 * first, which on an event that is re-sent on every edit of the sheet would be
 * most of them.
 */
function ensureMeet(cal, event) {
  var calId = cal.getId();
  // CalendarApp ids are "<id>@google.com"; the API wants the id alone.
  var eventId = event.getId().replace(/@.*$/, '');
  var current = Calendar.Events.get(calId, eventId);
  if (current.hangoutLink) return current.hangoutLink;
  var patched = Calendar.Events.patch(
    {
      conferenceData: {
        createRequest: {
          requestId: Utilities.getUuid(),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    },
    calId,
    eventId,
    // Version 1 is what makes the request a conference request at all, and
    // "all" is what sends the guests the link rather than leaving it sitting
    // on an event nobody was told about again.
    { conferenceDataVersion: 1, sendUpdates: 'all' }
  );
  return patched.hangoutLink || '';
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
  Logger.log('Writing to calendar: ' + targetCalendar().getName());
  // Fails loudly while the Calendar service is missing, which is the whole
  // reason to run this after pasting the file in.
  Logger.log('Calendar API reachable: ' + Boolean(Calendar.Events));
  Logger.log('Parsed: ' + parseInTz('2026-08-23 14:00:00', 'America/Los_Angeles'));
}
