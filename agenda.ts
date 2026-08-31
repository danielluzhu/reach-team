import { FAVICON_LINK } from "./auth";
import {
  STANDING_GUESTS,
  TOUR_TIMEZONE,
  fetchAgenda,
  guideEmails,
  leadNames,
  type AgendaEvent,
} from "./calendar";
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
      display: grid; grid-template-columns: 76px 104px 1fr; gap: 14px;
      padding: 9px 10px; border-radius: 8px; align-items: baseline;
    }
    .slot .lead-col { display: flex; gap: 4px; flex-wrap: wrap; min-width: 0; }
    /* On a phone the three columns become two lines rather than three slivers:
       time and lead stay together on top, the event reads underneath. */
    @media (max-width: 640px) {
      .slot { grid-template-columns: 76px 1fr; row-gap: 4px; }
      .slot .what { grid-column: 1 / -1; }
    }
    .slot + .slot { border-top: 1px solid #f1f3f5; }
    .slot:hover { background: #f7faff; }
    .slot .when { color: var(--muted); font-size: 0.85rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .slot .what { min-width: 0; }
    .slot .title { font-weight: 600; }
    .slot .where { color: var(--muted); font-size: 0.85rem; margin-top: 2px; }
    .slot .who { margin-top: 4px; display: flex; gap: 5px; flex-wrap: wrap; }
    /* Who is running it, as a name rather than an address: the thing you are
       looking for when scanning a day is a person, not a mailbox. Anyone else
       invited stays under the title, so the column holds one answer. */
    .person {
      font-size: 0.75rem; font-weight: 600; padding: 1px 8px; border-radius: 999px;
      background: #eef2ff; color: #3730a3;
    }
    /* The lead is the one name that answers "who is doing this", so it is the
       one that carries weight; anyone else invited sits behind it. */
    .person.lead { background: var(--accent); color: #fff; }
    /* Nobody named. A dash rather than the words "no lead", because in a column
       that repeats down the page the words become the loudest thing on it. */
    .person.none { background: none; color: var(--muted); font-weight: 400; padding-left: 2px; }
    .virtual-tag {
      display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px;
      font-size: 11px; font-weight: 700; background: #ede9fe; color: #5b21b6;
    }
    .filters { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 0 0 8px; }
    .filter-label {
      font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--muted); width: 64px; flex: none;
    }
    .chip {
      font-size: 0.78rem; text-decoration: none; padding: 3px 10px; border-radius: 999px;
      border: 1px solid var(--line); background: #fff; color: var(--ink); white-space: nowrap;
    }
    .chip:hover { border-color: var(--accent); color: var(--accent); }
    .chip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    /* The count is what makes a chip worth reading before clicking it. */
    .chip-n { opacity: 0.55; margin-left: 5px; font-variant-numeric: tabular-nums; }
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

/**
 * Who is on an event, said as names.
 *
 * The guest list is addresses, which is the least useful way to answer "who is
 * doing this one" while scanning a day. The guide map already pairs a first
 * name with an address, so it is read backwards here. An address nobody has
 * named shows the part before the @, which is usually close enough to
 * recognise and always better than forty characters of domain.
 *
 * The standing office mailbox is dropped: it is on every single event, so
 * printing it says nothing and crowds out the name that does.
 */
export function attendees(guests: string[]): string[] {
  const known = new Map(
    Object.entries(guideEmails()).map(([name, email]) => [
      email.toLowerCase(),
      name.charAt(0).toUpperCase() + name.slice(1),
    ])
  );
  const standing = new Set(STANDING_GUESTS.map((g) => g.toLowerCase()));
  const seen = new Set<string>();
  const names: string[] = [];
  for (const guest of guests) {
    const email = guest.toLowerCase().trim();
    if (!email || standing.has(email)) continue;
    const name = known.get(email) ?? guest.split("@")[0]!;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

/** "unassigned" is a placeholder the tour titles use, not a person. */
const NOT_A_PERSON = /^(unassigned|tbd|n\/a|none|\?+)$/i;

/**
 * Who is running an event.
 *
 * Three sources, in this order, because they disagree and the first is the
 * most deliberate:
 *
 *  1. A tour title says it outright — "2120 Anant <> Harsh & Andrew". This
 *     has to win: "2120 Andrew <> Harsh" is a prospect called Andrew being
 *     shown round by Harsh, and reading the title left to right would name
 *     the wrong person.
 *  2. A known name anywhere in the title, which is how the work is written:
 *     "1714 cleaning yuliet", "carlos 4544 clean", "2120 flooring quong".
 *     Matching against a list rather than guessing at word positions is what
 *     keeps "4544 301 claire move in" from making a tenant the lead.
 *  3. Whoever put the event on the calendar. An inspection invites nobody and
 *     names nobody, so the person who booked it is the only record of whose
 *     job it is — and in practice it is theirs.
 *  4. Failing all of those, whoever is invited.
 */
export function leadFor(
  title: string,
  guests: string[] = [],
  creators: string[] = []
): string[] {
  const arrow = title.split(/<>/)[1];
  if (arrow !== undefined) {
    const named = arrow
      .split(/&|,|\band\b|\//i)
      .map((n) => n.trim())
      .filter((n) => n && !NOT_A_PERSON.test(n));
    if (named.length) return named;
  }

  const found = leadNames().filter((name) =>
    new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(title)
  );
  if (found.length) return found;

  const host = attendees(creators);
  if (host.length) return host;

  return attendees(guests);
}

/**
 * The property an event is about, as its street number.
 *
 * Almost every title opens with it — "4735 4 cleaning carlos", "2120 flooring
 * quong" — because that is how the office refers to a building, and it is the
 * same short label the tour titles use. The location field is the better
 * source when there is one, but most hand-typed events have none.
 */
export function addressOf(e: AgendaEvent): string | null {
  const fromLocation = (e.location ?? "").match(/^\s*(\d{3,5})\b/);
  if (fromLocation) return fromLocation[1]!;
  const fromTitle = e.title.match(/^\s*(\d{3,5})\b/);
  return fromTitle ? fromTitle[1]! : null;
}

function renderEvent(e: AgendaEvent): string {
  const virtual = /\(virtual\)/i.test(e.title);
  const title = escapeHtml(e.title.replace(/\s*\(virtual\)\s*$/i, ""));
  const lead = leadFor(e.title, e.guests ?? [], e.creators ?? []);
  // Anyone invited who is not already named as the lead.
  const others = attendees(e.guests ?? []).filter(
    (n) => !lead.some((l) => l.toLowerCase() === n.toLowerCase())
  );
  // The lead has a column of its own between the time and the title, so a day
  // can be read down two narrow columns — when, and who — without the eye
  // having to enter each event to find out.
  const leadCell = lead.length
    ? lead.map((n) => `<span class="person lead">${escapeHtml(n)}</span>`).join("")
    : `<span class="person none">&mdash;</span>`;

  return (
    `<div class="slot">` +
    `<div class="when">${e.allDay ? "all day" : escapeHtml(clock(e.start))}</div>` +
    `<div class="lead-col">${leadCell}</div>` +
    `<div class="what">` +
    `<div class="title">${title}${virtual ? `<span class="virtual-tag">VIRTUAL</span>` : ""}</div>` +
    (e.location ? `<div class="where">${escapeHtml(e.location)}</div>` : "") +
    (others.length
      ? `<div class="who">${others
          .map((n) => `<span class="person">${escapeHtml(n)}</span>`)
          .join("")}</div>`
      : "") +
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
export type AgendaFilters = { address?: string; lead?: string };

/** A filter chip, which turns itself off when it is the one already on. */
function chip(label: string, active: boolean, href: string, count?: number): string {
  return (
    `<a class="chip${active ? " on" : ""}" href="${escapeHtml(href)}">${escapeHtml(label)}` +
    (count === undefined ? "" : `<span class="chip-n">${count}</span>`) +
    `</a>`
  );
}

export async function renderAgendaPage(
  nav: string,
  navCss: string,
  start?: string,
  filters: AgendaFilters = {}
): Promise<string> {
  const today = todayHere();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(start ?? "") ? start! : today;
  const to = addDays(from, WINDOW_DAYS - 1);

  let body: string;
  let bar = "";
  let heading = "Calendar";
  try {
    const { calendar, events } = await fetchAgenda(from, to);
    if (calendar) heading = escapeHtml(calendar);

    // The filters are built from what this window actually holds, so they only
    // ever offer a choice that leads somewhere. Counts come from the unfiltered
    // set, so turning one on doesn't renumber the others.
    const addressCounts = new Map<string, number>();
    const leadCounts = new Map<string, number>();
    for (const e of events) {
      const a = addressOf(e);
      if (a) addressCounts.set(a, (addressCounts.get(a) ?? 0) + 1);
      for (const n of leadFor(e.title, e.guests ?? [], e.creators ?? [])) {
        leadCounts.set(n, (leadCounts.get(n) ?? 0) + 1);
      }
    }

    const keep = events.filter((e) => {
      if (filters.address && addressOf(e) !== filters.address) return false;
      if (filters.lead) {
        const names = leadFor(e.title, e.guests ?? [], e.creators ?? []);
        const wanted = filters.lead.toLowerCase();
        if (wanted === "none") return names.length === 0;
        if (!names.some((n) => n.toLowerCase() === wanted)) return false;
      }
      return true;
    });

    const link = (next: AgendaFilters) => {
      const p = new URLSearchParams();
      if (start) p.set("start", from);
      if (next.address) p.set("address", next.address);
      if (next.lead) p.set("lead", next.lead);
      const q = p.toString();
      return q ? `/calendar?${q}` : "/calendar";
    };

    bar =
      `<div class="filters">` +
      `<span class="filter-label">Property</span>` +
      chip("all", !filters.address, link({ lead: filters.lead })) +
      [...addressCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([a, n]) =>
          chip(a, filters.address === a, link({ address: filters.address === a ? undefined : a, lead: filters.lead }), n)
        )
        .join("") +
      `</div>` +
      `<div class="filters">` +
      `<span class="filter-label">Lead</span>` +
      chip("all", !filters.lead, link({ address: filters.address })) +
      [...leadCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([n, c]) =>
          chip(n, filters.lead?.toLowerCase() === n.toLowerCase(),
            link({ address: filters.address, lead: filters.lead?.toLowerCase() === n.toLowerCase() ? undefined : n }), c)
        )
        .join("") +
      chip("nobody", filters.lead === "none",
        link({ address: filters.address, lead: filters.lead === "none" ? undefined : "none" })) +
      `</div>`;

    const days = byDay(keep);
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
      : `<p class="agenda-empty">${
          filters.address || filters.lead
            ? "Nothing matches that filter in this window."
            : `Nothing on the calendar between ${escapeHtml(niceDay(from))} and ${escapeHtml(niceDay(to))}.`
        }</p>`;
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
${bar}
${body}
  </div>
</body>
</html>`;
}
