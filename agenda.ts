import { FAVICON_LINK } from "./auth";
import { TOUR_TIMEZONE, fetchAgenda, type AgendaEvent } from "./calendar";
import { PAGE_CSS } from "./inspections";

/**
 * The calendar page: what is actually on the office calendar, drawn here.
 *
 * Not a Google embed. That calendar is private, and its event descriptions
 * carry prospect names and phone numbers — making it public so an iframe would
 * render is not a trade worth making, and a private one only renders for a
 * viewer who happens to be signed into the right Google account. Asking the
 * Apps Script, which already runs as the calendar's owner, works for anyone
 * signed into this app and keeps the calendar shut.
 *
 * It is re-read on every page load. There is no cache on purpose: a stale
 * agenda after somebody moved a tour on their phone is the one failure this
 * page must not have.
 */

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** How much of the calendar a page shows at once. */
export const WINDOW_DAYS = 30;

const dayNames = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d + days));
  return at.toISOString().slice(0, 10);
}

/** Today in the property's timezone, which is the day the office is having. */
export function todayHere(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TOUR_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function niceDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return dayNames.format(new Date(Date.UTC(y, m - 1, d)));
}

/** "14:30:00" → "2:30pm". Lower case, because a column of times is read fast. */
function clock(stamp: string): string {
  const time = stamp.split(" ")[1];
  if (!time) return "";
  const [h, m] = time.split(":").map(Number) as [number, number];
  const ampm = h < 12 ? "am" : "pm";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour}${ampm}` : `${hour}:${String(m).padStart(2, "0")}${ampm}`;
}

const AGENDA_CSS = `
    .agenda-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 4px; }
    .agenda-nav { margin-left: auto; display: flex; gap: 8px; }
    .agenda-nav a {
      font-size: 0.85rem; text-decoration: none; padding: 5px 11px;
      border: 1px solid var(--line); border-radius: 999px; background: #fff; color: var(--ink);
    }
    .agenda-nav a:hover { border-color: var(--accent); color: var(--accent); }
    .agenda-nav a.today { border-color: var(--accent); color: var(--accent); }
    .day { margin: 26px 0 0; }
    .day > h2 {
      font-size: 0.82rem; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--muted); margin: 0 0 8px; padding-bottom: 6px; border-bottom: 1px solid var(--line);
    }
    /* Today is the row somebody came to the page to read. */
    .day.is-today > h2 { color: var(--accent); border-bottom-color: var(--accent); }
    .slot {
      display: grid; grid-template-columns: 88px 1fr; gap: 14px;
      padding: 9px 10px; border-radius: 8px; align-items: baseline;
    }
    .slot + .slot { border-top: 1px solid #f1f3f5; }
    .slot:hover { background: #f7faff; }
    .slot .when { color: var(--muted); font-size: 0.85rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .slot .what { min-width: 0; }
    .slot .title { font-weight: 600; }
    .slot .where { color: var(--muted); font-size: 0.85rem; margin-top: 2px; }
    .slot .who { color: var(--muted); font-size: 0.8rem; margin-top: 2px; }
    .virtual-tag {
      display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px;
      font-size: 11px; font-weight: 700; background: #ede9fe; color: #5b21b6;
    }
    .agenda-empty { color: var(--muted); padding: 26px 0; }
    .agenda-problem {
      padding: 14px 16px; border-radius: 8px; background: #fff8e1;
      border: 1px solid #f0d68a; color: #6b5300; line-height: 1.6;
    }
    .agenda-problem code { background: rgba(0,0,0,0.06); padding: 0 0.25rem; border-radius: 3px; }
`;

/** Events grouped by the day they start on, days in order, empty days dropped. */
function byDay(events: AgendaEvent[]): [string, AgendaEvent[]][] {
  const days = new Map<string, AgendaEvent[]>();
  for (const e of events) {
    const day = e.start.slice(0, 10);
    days.set(day, [...(days.get(day) ?? []), e]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([day, list]) =>
        [day, list.sort((a, b) => (a.allDay ? "" : a.start).localeCompare(b.allDay ? "" : b.start))] as [
          string,
          AgendaEvent[],
        ]
    );
}

function renderEvent(e: AgendaEvent): string {
  const virtual = /\(virtual\)/i.test(e.title);
  const title = escapeHtml(e.title.replace(/\s*\(virtual\)\s*$/i, ""));
  // The guest list is who is expected there, which is the useful half of the
  // description without reprinting a prospect's phone number on a wall display.
  const guests = (e.guests ?? []).join(", ");
  return (
    `<div class="slot">` +
    `<div class="when">${e.allDay ? "all day" : escapeHtml(clock(e.start))}</div>` +
    `<div class="what">` +
    `<div class="title">${title}${virtual ? `<span class="virtual-tag">VIRTUAL</span>` : ""}</div>` +
    (e.location ? `<div class="where">${escapeHtml(e.location)}</div>` : "") +
    (guests ? `<div class="who">${escapeHtml(guests)}</div>` : "") +
    `</div></div>`
  );
}

function problemHtml(reason: string): string {
  if (reason === "not-configured") {
    return `<div class="agenda-problem"><strong>The calendar isn't connected yet.</strong>
      Set <code>CALENDAR_WEBHOOK_URL</code> and <code>CALENDAR_WEBHOOK_SECRET</code> in
      <code>.env</code> and restart — see <code>google-apps-script/tour-calendar.gs</code>.</div>`;
  }
  if (reason === "old-deployment") {
    return `<div class="agenda-problem"><strong>The Apps Script needs re-deploying.</strong>
      The version currently serving doesn't know how to list the calendar. In the script editor:
      <em>Deploy → Manage deployments → edit → Version: New version → Deploy</em>. The URL
      doesn't change, and this page will work on the next load.</div>`;
  }
  return `<div class="agenda-problem"><strong>Couldn't read the calendar.</strong>
    ${escapeHtml(reason)}</div>`;
}

/**
 * The page. `start` is the first day shown; the window runs WINDOW_DAYS from
 * there, so the arrows page through the calendar a month at a time.
 */
export async function renderAgendaPage(
  nav: string,
  navCss: string,
  start?: string
): Promise<string> {
  const today = todayHere();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(start ?? "") ? start! : today;
  const to = addDays(from, WINDOW_DAYS - 1);

  let body: string;
  let heading = "Calendar";
  try {
    const { calendar, events } = await fetchAgenda(from, to);
    if (calendar) heading = escapeHtml(calendar);
    const days = byDay(events);
    body = days.length
      ? days
          .map(
            ([day, list]) =>
              `<section class="day${day === today ? " is-today" : ""}">` +
              `<h2>${escapeHtml(niceDay(day))}${day === today ? " · today" : ""}</h2>` +
              list.map(renderEvent).join("") +
              `</section>`
          )
          .join("")
      : `<p class="agenda-empty">Nothing on the calendar between
         ${escapeHtml(niceDay(from))} and ${escapeHtml(niceDay(to))}.</p>`;
  } catch (err) {
    body = problemHtml(err instanceof Error ? err.message : String(err));
  }

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Calendar</title>
  ${FAVICON_LINK}
  <style>
${navCss}
${PAGE_CSS}
${AGENDA_CSS}
  </style>
</head>
<body>
  ${nav}
  <div class="page">
    <div class="agenda-head">
      <h1>${heading}</h1>
      <nav class="agenda-nav">
        <a href="/calendar?start=${addDays(from, -WINDOW_DAYS)}">&larr; earlier</a>
        <a class="today" href="/calendar">today</a>
        <a href="/calendar?start=${addDays(from, WINDOW_DAYS)}">later &rarr;</a>
      </nav>
    </div>
    <p class="lede">${escapeHtml(niceDay(from))} to ${escapeHtml(niceDay(to))} &mdash;
      read from the calendar each time this page is opened, so it is never stale.</p>
${body}
  </div>
</body>
</html>`;
}
