/**
 * Rental applications: the public form, and the office's list of what came in.
 *
 * The form is its own app (applications/, on :3200), bound to localhost like the
 * checklist app. The internet reaches this CRM and nothing else, so the form is
 * served from here at /apply — without a sign-in, because the people filling it
 * in have no account and shouldn't need one — and passed on to :3200 through an
 * allowlist of the paths the form actually uses.
 *
 * What was submitted is read here out of `applications.db`, **read-only**, and
 * shown behind the sign-in on the Applications tab. Nothing in the CRM writes
 * to that database: an application only exists because somebody submitted one.
 */
import { Database } from "bun:sqlite";
import { FAVICON_LINK, trustedOrigins } from "./auth";
import { PAGE_CSS } from "./inspections";

const APPLY_DIR = process.env.APPLY_DIR ?? "applications";
const APPLY_DB = process.env.APPLY_DB ?? `${APPLY_DIR}/applications.db`;
const PDF_DIR = process.env.APPLY_PDF_DIR ?? `${APPLY_DIR}/pdfs`;
const APPLY_URL = process.env.APPLY_URL ?? "http://127.0.0.1:3200";

/** Where the public form lives on this app. */
export const APPLY_PREFIX = "/apply";

export const isApplyPath = (pathname: string) =>
  pathname === APPLY_PREFIX || pathname.startsWith(`${APPLY_PREFIX}/`);

/**
 * Every path the form asks for. This is an unauthenticated door onto :3200, so
 * nothing else goes through — in particular not `/applications/<id>.pdf`, the
 * office's copy by id, and never an uploaded document: those are people's IDs
 * and pay stubs, and the public side of this app only ever sends them one way.
 * `/copy/<receipt>.pdf` is the applicant's own copy, on the link they were
 * handed when they submitted.
 */
const PUBLIC_PATHS: RegExp[] = [
  /^\/$/,
  /^\/favicon\.svg$/,
  /^\/api\/terms$/,
  /^\/api\/uploads$/,
  /^\/api\/applications$/,
  /^\/api\/client-error$/,
  /^\/copy\/[0-9a-f]{64}\.pdf$/,
];

export async function proxyApplyForm(req: Request, url: URL): Promise<Response> {
  // The bare /apply is the link people are given; the page wants its trailing
  // slash so that it and every path under it read the same way.
  if (url.pathname === APPLY_PREFIX) {
    return new Response(null, {
      status: 308,
      headers: { Location: `${APPLY_PREFIX}/${url.search}`, "Cache-Control": "no-store" },
    });
  }
  const path = url.pathname.slice(APPLY_PREFIX.length) || "/";
  if (!PUBLIC_PATHS.some((allowed) => allowed.test(path))) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store, private" } });
  }

  const headers = new Headers();
  // Only what the form app reads. Anyone signed in to the CRM who opens the
  // form keeps their session cookie here, where it belongs.
  for (const name of ["content-type", "content-length", "accept", "user-agent"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("X-Forwarded-Prefix", APPLY_PREFIX);

  const body = req.method === "GET" || req.method === "HEAD" ? undefined : req.body;
  try {
    const res = await fetch(`${APPLY_URL}${path}${url.search}`, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      ...(body ? { duplex: "half" } : {}),
    } as RequestInit);
    const out = new Headers(res.headers);
    out.set("Cache-Control", "no-store, private");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  } catch (err) {
    console.warn(`Could not reach the application form at ${APPLY_URL}.`, err);
    return new Response(
      "The application form can't be opened right now. Please try again in a few minutes.",
      { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store, private" } }
    );
  }
}

/* ------------------------------------------------------------ the office's list */

type Money = string;
type Stored = {
  id: string;
  submittedAt: string;
  property: string;
  moveIn: string;
  leaseTerm: string;
  name: string;
  email: string;
  phone: string;
  residences: { address: string }[];
  jobs: { employer: string; monthlyIncome: Money }[];
  otherIncome: string;
  occupants: { name: string; adult: boolean }[];
  pets: string;
  vehicles: unknown[];
  attachments: { name: string }[];
};

/** Opened per request: the form app writes to it while the CRM runs. */
function listApplications(): Stored[] | null {
  let db: Database | null = null;
  try {
    db = new Database(APPLY_DB, { readonly: true });
    const rows = db.query(`SELECT data FROM applications ORDER BY submitted_at DESC`).all() as { data: string }[];
    return rows.flatMap((r) => {
      try {
        return [JSON.parse(r.data) as Stored];
      } catch {
        return [];
      }
    });
  } catch (err) {
    // No database yet is the ordinary state before the first application.
    if (!(err instanceof Error && /unable to open|no such table/i.test(err.message))) {
      console.warn(`Could not read ${APPLY_DB}.`, err);
      return null;
    }
    return [];
  } finally {
    db?.close();
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

/** "$4,500" or "4500/mo" or "about 4k" — whatever parses as a number counts. */
function monthlyIncome(a: Stored): number | null {
  const amounts = a.jobs
    .map((j) => Number(String(j.monthlyIncome).replace(/[^\d.]/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  return amounts.length ? amounts.reduce((s, n) => s + n, 0) : null;
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" });
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });

function listRow(a: Stored): string {
  const income = monthlyIncome(a);
  const others = a.occupants.length;
  const adults = a.occupants.filter((o) => o.adult).length;
  const household = [
    others ? `${others} other${others === 1 ? "" : "s"}${adults ? ` (${adults} adult${adults === 1 ? "" : "s"})` : ""}` : "Just them",
    a.pets ? `pets: ${a.pets}` : "",
    a.vehicles.length ? `${a.vehicles.length} vehicle${a.vehicles.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  const search = [a.property, a.name, a.email, a.phone].join(" ").toLowerCase();
  return `
        <tr data-search="${escapeHtml(search)}">
          <td class="when">${escapeHtml(day(a.submittedAt))}<span class="time">${escapeHtml(time(a.submittedAt))}</span></td>
          <td class="address"><strong>${escapeHtml(a.property)}</strong>
            <span class="sub">Move in ${escapeHtml(a.moveIn)} &middot; ${escapeHtml(a.leaseTerm)}</span></td>
          <td class="who">${escapeHtml(a.name)}
            <span class="sub"><a href="mailto:${escapeHtml(a.email)}">${escapeHtml(a.email)}</a></span>
            <span class="sub"><a href="tel:${escapeHtml(a.phone.replace(/[^\d+]/g, ""))}">${escapeHtml(a.phone)}</a></span></td>
          <td>${income === null ? `<span class="muted">${a.otherIncome ? "Other income only" : "None listed"}</span>` : `$${income.toLocaleString("en-US")}/mo`}
            <span class="sub">${escapeHtml(a.jobs.map((j) => j.employer).join(", "))}</span></td>
          <td>${household.map((h) => escapeHtml(h)).join("<br />")}</td>
          <td>${a.attachments.length || `<span class="muted">none</span>`}</td>
          <td class="actions"><a class="pdf-link" href="/applications/${a.id}.pdf" target="_blank" rel="noopener">PDF</a></td>
        </tr>`;
}

const LIST_CSS = `
    [hidden] { display: none !important; }
    .share { background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 0.75rem 0.9rem;
      margin: 0 0 1.1rem; font-size: 0.88rem; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    .share code { background: #f3f4f6; padding: 0.15rem 0.35rem; border-radius: 4px; overflow-wrap: anywhere; }
    .share button { margin-left: 0.4rem; background: #fff; border: 1px solid #d1d5db; border-radius: 6px;
      padding: 0.25rem 0.6rem; font: 600 0.78rem system-ui, sans-serif; color: #374151; cursor: pointer; }
    .share .sub { display: block; margin-top: 0.35rem; color: var(--muted); font-size: 0.8rem; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; margin: 0 0 0.9rem; }
    .toolbar input { flex: 1 1 16rem; max-width: 26rem; padding: 0.45rem 0.7rem; border: 1px solid #d1d5db;
      border-radius: 6px; font: inherit; font-size: 0.88rem; background: #fff; }
    .toolbar .count { color: var(--muted); font-size: 0.82rem; }
    .table-wrap { overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; background: #fff; font-size: 0.9rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { text-align: left; padding: 0.6rem 0.8rem; border-bottom: 1px solid #eee; vertical-align: top; }
    th { background: #f2f2f2; font-weight: 600; font-size: 0.82rem; white-space: nowrap; }
    tbody tr:hover { background: #f9f9f9; }
    td .sub, td.when .time { display: block; color: var(--muted); font-size: 0.78rem; overflow-wrap: anywhere; }
    td .sub a { color: inherit; }
    td.when { white-space: nowrap; }
    td.address { min-width: 12rem; }
    .muted { color: var(--muted); }
    td.actions { text-align: right; white-space: nowrap; }
    .empty td { color: var(--muted); text-align: center; padding: 1.5rem; }
`;

export function renderApplicationsList(nav: string, navCss: string): string {
  const applications = listApplications();
  // The address people are sent to: the public one this app is reached on,
  // not whatever host the request happened to come in by.
  const origin = trustedOrigins[0] ?? "";
  const link = `${origin}${APPLY_PREFIX}/`;
  const body =
    applications === null
      ? `  <h1>Applications</h1>
  <p class="notice"><strong>The applications database can't be read right now.</strong> It lives in
    <code>${escapeHtml(APPLY_DB)}</code>, written by the form app on :3200.</p>`
      : `  <h1>Applications</h1>
  <p class="lede">Rental applications submitted through the public form, newest first &mdash;
    ${applications.length} in all. Each PDF has the application, the signature and every document the
    applicant attached, in one file.</p>

  <div class="share">
    Send applicants to <code id="apply-link">${escapeHtml(link)}</code><button type="button" id="copy-apply">Copy</button>
    <span class="sub">No sign-in needed. Add <code>?property=</code> and an address to fill in which home it&rsquo;s for,
      e.g. <code>${escapeHtml(link)}?property=12+Example+Ave+NE</code>.</span>
  </div>

  <div class="toolbar">
    <input type="search" id="application-search" placeholder="Filter by property, name, email or phone"
      autocomplete="off" aria-label="Filter applications" />
    <span class="count" id="shown-count">${applications.length} ${applications.length === 1 ? "application" : "applications"}</span>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr><th>Submitted</th><th>Property</th><th>Applicant</th><th>Income</th><th>Household</th><th>Docs</th><th></th></tr></thead>
      <tbody id="applications">${
        applications.length
          ? applications.map(listRow).join("") +
            `\n        <tr class="empty no-match" hidden><td colspan="7">No application matches that.</td></tr>`
          : `\n        <tr class="empty"><td colspan="7">No applications yet.</td></tr>`
      }
      </tbody>
    </table>
  </div>
  <script>
    (function () {
      var input = document.getElementById("application-search");
      var rows = Array.prototype.slice.call(document.querySelectorAll("#applications tr[data-search]"));
      var none = document.querySelector("#applications .no-match");
      var count = document.getElementById("shown-count");
      input.addEventListener("input", function () {
        var words = input.value.toLowerCase().split(/\\s+/).filter(Boolean);
        var shown = 0;
        rows.forEach(function (tr) {
          var hit = words.every(function (w) { return tr.dataset.search.indexOf(w) !== -1; });
          tr.hidden = !hit;
          if (hit) shown++;
        });
        if (none) none.hidden = shown > 0;
        count.textContent = shown + (shown === 1 ? " application" : " applications");
      });
      document.getElementById("copy-apply").addEventListener("click", function () {
        var button = this;
        navigator.clipboard.writeText(document.getElementById("apply-link").textContent).then(function () {
          button.textContent = "Copied";
          setTimeout(function () { button.textContent = "Copy"; }, 1500);
        });
      });
    })();
  </script>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Applications</title>
  ${FAVICON_LINK}
  <style>
${navCss}
${PAGE_CSS}
${LIST_CSS}
  </style>
</head>
<body>
  ${nav}
  <div class="page">
${body}
  </div>
</body>
</html>`;
}

/**
 * The office's copy. Read off the form app's disk; if the file has gone, the
 * form app rebuilds it from the stored answers.
 */
export async function serveApplicationPdf(id: string): Promise<Response> {
  const headers = { "Content-Type": "application/pdf", "Cache-Control": "no-store, private" };
  let db: Database | null = null;
  let file: string | null = null;
  try {
    db = new Database(APPLY_DB, { readonly: true });
    const row = db.query(`SELECT pdf_file FROM applications WHERE id = ?`).get(id) as { pdf_file: string | null } | null;
    if (!row) return new Response("That application doesn't exist.", { status: 404 });
    file = row.pdf_file;
  } catch {
    return new Response("That application doesn't exist.", { status: 404 });
  } finally {
    db?.close();
  }
  if (file && /^[\w.-]+\.pdf$/.test(file)) {
    const saved = Bun.file(`${PDF_DIR}/${file}`);
    if (await saved.exists()) return new Response(saved, { headers });
  }
  try {
    const res = await fetch(`${APPLY_URL}/applications/${id}.pdf`);
    if (res.ok) return new Response(res.body, { headers });
  } catch (err) {
    console.warn(`Could not reach the application form at ${APPLY_URL}.`, err);
  }
  return new Response("That PDF can't be produced right now.", { status: 502 });
}
