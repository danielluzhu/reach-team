import {
  DOC_CSS,
  describeProperty,
  docSections,
  isProperty,
  renderWorkflowPage,
  sectionHtml,
  type Section,
} from "./doc";
import {
  enqueueNewTours,
  flushQueue,
  startCalendarWorker,
} from "./calendar";
import { renderAgendaPage } from "./agenda";
import { db, SHEET_VERSIONS_KEPT } from "./db";
import {
  MAX_PHOTOS,
  addReport,
  allowCar,
  allowedFor,
  disallowCar,
  deleteReport,
  renderPlatesPage,
  savePhotos,
  servePlatePhoto,
  STATES,
} from "./plates";
import {
  addInspectionNote,
  deleteInspectionNote,
  renderInspection,
  renderInspectionsList,
  renderNote,
  serveInspectionPdf,
  serveInspectionUpload,
} from "./inspections";
import {
  trustedOrigins,
  authenticate,
  handleLogin,
  handleLogout,
  handleSetup,
  handleRegister,
  renderLogin,
  renderSetup,
  renderRegister,
  accountCount,
  isLoopback,
  displayName,
  canEditTenants,
  FAVICON_LINK,
  PAGE_HEADERS,
  type User,
} from "./auth";

// Home / Unit Info had a tab of its own until the two were merged; /doc now
// redirects into the homes half of this page.
const LEADING_NAV_LINKS: [string, string][] = [["/", "Tenants, Access & Homes"]];

/**
 * The sheets sit between these and the access page, which is what puts Tours &
 * Prospects — the first sheet by `position` — second in the bar. Inspections
 * are read after them; the workflow is the reference doc behind those sheets
 * rather than something opened daily, so it reads last.
 */
const TRAILING_NAV_LINKS: [string, string][] = [
  ["/calendar", "Calendar"],
  ["/inspections", "Inspections"],
  ["/plates", "Driveway Plates"],
  ["/workflow", "Prospect Workflow"],
];

type SheetTab = { id: string; name: string };

const listSheetTabs = db.query("SELECT id, name FROM sheets ORDER BY position, id");

/**
 * Every sheet is a top-level tab of its own, so the bar is built from the
 * `sheets` table rather than written out here: rename a sheet, add one or
 * reorder them and the nav follows on the next page load. Which sheet comes
 * first is the `position` column's business — reorder them there, not here.
 */
function navLinks(): [string, string][] {
  const sheets = listSheetTabs.all() as SheetTab[];
  return [
    ...LEADING_NAV_LINKS,
    ...sheets.map((s) => [`/sheets/${s.id}`, s.name] as [string, string]),
    ...TRAILING_NAV_LINKS,
  ];
}

function navLinksHtml(active: string): string {
  return navLinks()
    .map(
      ([href, label]) =>
        `<a href="${href}"${href === active ? ' class="active"' : ""}>${escapeHtml(label)}</a>`
    )
    .join("");
}

function navUserHtml(user: User): string {
  return (
    `<span class="app-user">${escapeHtml(displayName(user))}` +
    `<form method="POST" action="/logout"><button type="submit">Sign out</button></form></span>`
  );
}

function renderNav(active: string, user: User): string {
  return `<nav class="app-nav">${navLinksHtml(active)}${navUserHtml(user)}</nav>`;
}

const NAV_CSS = `
    /* One tab per page and one per sheet, so the bar can outgrow a phone —
       it scrolls sideways rather than wrapping or squashing the labels. */
    .app-nav { display: flex; gap: 1.25rem; align-items: center; padding: 0.7rem 1.25rem;
      background: #1f2937; font: 500 0.875rem system-ui, sans-serif; margin-bottom: 1.25rem;
      overflow-x: auto; }
    .app-nav a { color: #cbd5e1; text-decoration: none; padding-bottom: 2px; border-bottom: 2px solid transparent;
      white-space: nowrap; }
    .app-nav a:hover { color: #fff; }
    .app-nav a.active { color: #fff; border-bottom-color: #60a5fa; }
    .app-nav .app-user { margin-left: auto; display: flex; align-items: center; gap: 0.6rem;
      color: #94a3b8; font-size: 0.8rem; }
    .app-nav .app-user form { margin: 0; }
    .app-nav .app-user button { background: none; border: 0; padding: 0; cursor: pointer;
      color: #94a3b8; font: inherit; text-decoration: underline; }
    .app-nav .app-user button:hover { color: #fff; }`;

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Same, but safe inside a double-quoted attribute. */
function escapeAttr(value: unknown): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

/**
 * The rows seeded when the table was created use reserved-for-fiction contact
 * details. Real tenants now sit alongside them, so each placeholder is tagged
 * individually rather than the whole table being called sample data.
 */
function isSampleTenant(t: any): boolean {
  return /@example\.(com|org|net)$/i.test(t.email ?? "") || /^555-01\d\d$/.test(t.phone ?? "");
}

/** Unit door code, with the shared building code above it where there is one. */
function renderAccess(t: any): string {
  if (!t.access_code && !t.building_code) return "";
  const building = t.building_code
    ? `<span class="code-building">bldg ${escapeHtml(t.building_code)}</span>`
    : "";
  const unit = t.access_code ? `<span class="code-unit">${escapeHtml(t.access_code)}</span>` : "";
  return `${building}${unit}`;
}

/**
 * The table's columns, in the order they ship. Dan can reorder and resize them
 * for everyone (see the layout routes below); `field` is the stable key that
 * order is stored against, so a label can be reworded without stranding a saved
 * layout. `Edit` isn't here — it's the actions column, pinned last and only
 * rendered for whoever may edit.
 */
const TENANT_COLUMNS = [
  { field: "property", label: "Property", width: 180 },
  { field: "unit", label: "Unit", width: 80 },
  { field: "access", label: "Access", width: 100 },
  { field: "status", label: "Status", width: 95 },
  { field: "vacant_until", label: "Vacant until", width: 110 },
  { field: "name", label: "Name", width: 160 },
  { field: "email", label: "Email", width: 185 },
  { field: "phone", label: "Phone", width: 130 },
  { field: "lease", label: "Lease", width: 160 },
  { field: "rent", label: "Rent", width: 85 },
] as const;

type Column = { field: string; label: string; width: number };

const ACTIONS_WIDTH = 80;
const MIN_COLUMN_WIDTH = 48;
const MAX_COLUMN_WIDTH = 2000;
const COLUMN_LAYOUT_KEY = "tenant_columns";

function clampWidth(value: unknown, fallback: number): number {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width)) return fallback;
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width));
}

const readSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const writeSetting = db.prepare(
  `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, CURRENT_TIMESTAMP, ?)
   ON CONFLICT(key) DO UPDATE SET
     value = excluded.value, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by`
);

/**
 * The saved column layout, or the defaults. Anything stored is filtered back
 * through TENANT_COLUMNS rather than trusted: a column dropped from the code
 * disappears from a stale layout, and one added since lands at the end, where
 * it's visible rather than silently missing.
 */
function loadColumnLayout(): Column[] {
  const stored = (readSetting.get(COLUMN_LAYOUT_KEY) as { value: string } | undefined)?.value;
  const defaults = new Map(TENANT_COLUMNS.map((c) => [c.field, c as Column]));
  const layout: Column[] = [];

  if (stored) {
    try {
      for (const entry of JSON.parse(stored) as any[]) {
        const base = defaults.get(entry?.field);
        if (!base) continue; // unknown or already placed
        defaults.delete(base.field);
        layout.push({ ...base, width: clampWidth(entry.width, base.width) });
      }
    } catch {
      console.warn(`Ignoring unreadable ${COLUMN_LAYOUT_KEY} setting; using the default columns.`);
    }
  }
  for (const c of TENANT_COLUMNS) if (defaults.has(c.field)) layout.push({ ...c });
  return layout;
}

/**
 * The columns the page lets you change. `id`, `created_at` and `notes` are
 * deliberately absent: the first two aren't yours to set, and `notes` carries
 * the import provenance rather than anything shown in the table.
 */
const EDITABLE_FIELDS = [
  "property_address",
  "unit",
  "access_code",
  "building_code",
  "status",
  "first_name",
  "last_name",
  "email",
  "phone",
  "lease_start",
  "lease_end",
  "rent_amount",
] as const;

/** Must stay in step with the CHECK constraint in schema.sql. */
const TENANT_STATUSES = ["active", "past", "pending", "vacant", "rented"];

/** Rented rows are kept out of the way, in the collapsed section at the bottom. */
const HIDDEN_STATUS = "rented";

const TEXT_MAX = 200;

/**
 * Turns a submitted row into values SQLite will accept, or explains what's
 * wrong. Blank strings become NULL so an emptied field reads as "unknown"
 * rather than as an empty string, which is how the imported rows record it.
 */
function validateTenant(body: any): { values: any[] } | { error: string } {
  if (!body || typeof body !== "object") return { error: "expected a JSON object of fields" };

  const text = (field: string): string | null => {
    const value = String(body[field] ?? "").trim();
    return value === "" ? null : value.slice(0, TEXT_MAX);
  };

  const firstName = text("first_name");
  const lastName = text("last_name");
  if (!firstName && !lastName) return { error: "A tenant needs a first or last name." };

  const status = String(body.status ?? "").trim();
  if (!TENANT_STATUSES.includes(status)) {
    return { error: `Status must be one of: ${TENANT_STATUSES.join(", ")}.` };
  }

  const date = (field: string, label: string): string | null | { error: string } => {
    const value = text(field);
    if (value === null) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
      return { error: `${label} must be a date like 2026-08-31.` };
    }
    return value;
  };
  const leaseStart = date("lease_start", "Lease start");
  if (leaseStart && typeof leaseStart === "object") return leaseStart;
  const leaseEnd = date("lease_end", "Lease end");
  if (leaseEnd && typeof leaseEnd === "object") return leaseEnd;
  if (leaseStart && leaseEnd && (leaseStart as string) > (leaseEnd as string)) {
    return { error: "Lease start is after lease end." };
  }

  const rentRaw = text("rent_amount");
  let rent: number | null = null;
  if (rentRaw !== null) {
    rent = Number(rentRaw);
    if (!Number.isFinite(rent) || rent < 0) return { error: "Rent must be a number, or blank." };
  }

  // NOT NULL on both name columns, so the one that was left out becomes "".
  return {
    values: [
      text("property_address"),
      text("unit"),
      text("access_code"),
      text("building_code"),
      status,
      firstName ?? "",
      lastName ?? "",
      text("email"),
      text("phone"),
      leaseStart as string | null,
      leaseEnd as string | null,
      rent,
    ],
  };
}

const insertTenant = db.query(
  `INSERT INTO tenants
     (property_address, unit, access_code, building_code, status,
      first_name, last_name, email, phone, lease_start, lease_end, rent_amount)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
);

const updateTenant = db.prepare(
  `UPDATE tenants SET
     property_address = ?, unit = ?, access_code = ?, building_code = ?, status = ?,
     first_name = ?, last_name = ?, email = ?, phone = ?,
     lease_start = ?, lease_end = ?, rent_amount = ?
   WHERE id = ?`
);

/**
 * The fold at the foot of the table. Everyone gets this one — reading the
 * rented rows doesn't depend on being allowed to edit them. The chevron and the
 * rows both follow aria-expanded, so anything else that opens the section (a
 * row edited to "rented", below) only has to set that attribute.
 */
const TOGGLE_JS = `
(function () {
  var button = document.getElementById("toggle-rented");
  var body = document.getElementById("rented-rows");
  if (!button || !body) return;
  button.addEventListener("click", function () {
    var open = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", open ? "false" : "true");
    body.hidden = open;
  });
})();`;

/**
 * Row editing and column layout, served only to a user who is allowed to save
 * either. Both live in one scope because they touch the same rows: reordering
 * columns has to close an open editor first, and a row that comes back from a
 * save has to be put into the current column order.
 *
 * Only one row edits at a time, so "what was here before" is a single variable
 * rather than state hung off every row.
 */
const PAGE_JS = `
(function () {
  // By id, not the first table on the page: the home sections below carry unit
  // tables of their own, and this script must not touch them.
  var table = document.getElementById("access-table");
  if (!table) return;
  var STATUSES = ${JSON.stringify(TENANT_STATUSES)};
  var DEFAULT_COLUMNS = ${JSON.stringify(TENANT_COLUMNS)};
  var MIN_W = ${MIN_COLUMN_WIDTH}, MAX_W = ${MAX_COLUMN_WIDTH};
  var open = null; // { tr: element, html: its markup before editing }

  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  }
  function cell(tr, col) {
    return tr.querySelector('td[data-col="' + col + '"]');
  }
  function input(field, value, attrs) {
    return '<input data-f="' + field + '" value="' + esc(value) + '" ' + (attrs || "") + ">";
  }
  function statusSelect(value) {
    var html = '<select data-f="status">';
    for (var i = 0; i < STATUSES.length; i++) {
      html += '<option value="' + STATUSES[i] + '"' + (STATUSES[i] === value ? " selected" : "") +
        ">" + STATUSES[i] + "</option>";
    }
    return html + "</select>";
  }
  function swap(tr, html) {
    var host = document.createElement("tbody");
    host.innerHTML = html;
    var fresh = host.firstElementChild;
    tr.replaceWith(fresh);
    // The server renders rows in the layout it has stored; if the columns have
    // been dragged since, put the new row in step with the rest of the table.
    orderRow(fresh, currentOrder());
    return fresh;
  }

  /**
   * A saved row belongs to whichever section its status puts it in. Moving it
   * there beats leaving a "rented" row sitting among the active ones until the
   * next reload. The section is opened on the way in so the row doesn't appear
   * to vanish.
   */
  function reseat(tr) {
    var body = document.getElementById("rented-rows");
    var button = document.getElementById("toggle-rented");
    if (!body || !button) return; // page rendered without the section
    var rented = cell(tr, "status") && cell(tr, "status").querySelector(".status.rented");
    var home = rented ? body : table.querySelector("tbody");
    if (tr.parentElement !== home) {
      home.appendChild(tr);
      if (rented) {
        button.setAttribute("aria-expanded", "true");
        body.hidden = false;
      }
    }
    var count = body.querySelectorAll("tr[data-id]").length;
    button.querySelector(".count").textContent = count;
    button.closest("tbody").hidden = count === 0;
    if (count === 0) {
      body.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
  }
  function showError(tr, message) {
    var box = cell(tr, "actions");
    if (!box) return;
    var span = box.querySelector(".field-error");
    if (!message) { if (span) span.remove(); return; }
    if (!span) {
      span = document.createElement("span");
      span.className = "field-error";
      box.appendChild(span);
    }
    span.textContent = message;
  }

  /** Cancelling an existing row puts its markup back; a draft just goes away. */
  function cancel() {
    if (!open) return;
    var tr = open.tr, html = open.html;
    open = null;
    if (html === null) {
      tr.remove();
      toggleEmptyRow();
      return;
    }
    swap(tr, html);
  }

  function fillEditor(tr, t) {
    tr.classList.add("editing");
    cell(tr, "property").innerHTML = input("property_address", t.property_address);
    cell(tr, "unit").innerHTML = input("unit", t.unit);
    cell(tr, "access").innerHTML =
      input("building_code", t.building_code, 'placeholder="bldg"') +
      input("access_code", t.access_code, 'placeholder="unit"');
    cell(tr, "status").innerHTML = statusSelect(t.status);
    // Derived from lease_end, which the Lease cell already edits — showing the
    // old value here through the edit would look like a field you can't type in.
    if (cell(tr, "vacant_until")) cell(tr, "vacant_until").innerHTML = "";
    cell(tr, "name").innerHTML =
      input("first_name", t.first_name, 'placeholder="First"') +
      input("last_name", t.last_name, 'placeholder="Last"');
    cell(tr, "email").innerHTML = input("email", t.email, 'type="email"');
    cell(tr, "phone").innerHTML = input("phone", t.phone);
    cell(tr, "lease").innerHTML =
      input("lease_start", t.lease_start, 'type="date" title="Lease start"') +
      input("lease_end", t.lease_end, 'type="date" title="Lease end (on a vacant unit, vacant until)"');
    cell(tr, "rent").innerHTML = input("rent_amount", t.rent_amount, 'type="number" step="0.01" min="0"');
    cell(tr, "actions").innerHTML =
      '<button type="button" data-act="save">Save</button> ' +
      '<button type="button" data-act="cancel">Cancel</button>';
    var first = tr.querySelector("input, select");
    if (first) first.focus();
  }

  function startEdit(tr) {
    if (open && open.tr === tr) return;
    if (!tr.dataset.tenant) return;
    cancel();
    open = { tr: tr, html: tr.outerHTML };
    fillEditor(tr, JSON.parse(tr.dataset.tenant));
  }

  /** An empty row of cells in the table's current column order. */
  function blankRow() {
    var tr = document.createElement("tr");
    var html = "";
    currentOrder().forEach(function (field) {
      var col = DEFAULT_COLUMNS.filter(function (c) { return c.field === field; })[0];
      html += '<td data-col="' + field + '" data-label="' + esc(col ? col.label : field) + '"></td>';
    });
    tr.innerHTML = html + '<td data-col="actions" data-label="Edit" class="row-actions"></td>';
    return tr;
  }

  /** Add: a draft row at the top of the table, saved only once you say so. */
  function startAdd() {
    cancel();
    var tbody = table.querySelector("tbody");
    var tr = blankRow();
    tr.dataset.draft = "1";
    tbody.insertBefore(tr, tbody.firstElementChild);
    open = { tr: tr, html: null }; // no markup to go back to — cancel removes it
    fillEditor(tr, { status: "active" });
    toggleEmptyRow();
  }

  /** The "No tenants yet" row only belongs there while the table is empty. */
  function toggleEmptyRow() {
    var empty = table.querySelector("tr.empty-row");
    if (empty) empty.hidden = !!table.querySelector("tr[data-id], tr[data-draft]");
  }

  function save(tr) {
    var body = {};
    tr.querySelectorAll("[data-f]").forEach(function (el) { body[el.dataset.f] = el.value; });
    var buttons = tr.querySelectorAll(".row-actions button");
    buttons.forEach(function (b) { b.disabled = true; });
    showError(tr, "");

    var adding = !tr.dataset.id;
    fetch(adding ? "/api/tenants" : "/api/tenants/" + tr.dataset.id, {
      method: adding ? "POST" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (res) {
        return res.json()
          .catch(function () { return {}; })
          .then(function (data) { return { ok: res.ok, data: data }; });
      })
      .then(function (r) {
        if (!r.ok) throw new Error(r.data.error || "Save failed.");
        open = null;
        reseat(swap(tr, r.data.row));
        toggleEmptyRow();
      })
      .catch(function (err) {
        buttons.forEach(function (b) { b.disabled = false; });
        showError(tr, err.message || "Save failed.");
      });
  }

  table.addEventListener("click", function (e) {
    var button = e.target.closest("button[data-act]");
    if (!button) return;
    var tr = button.closest("tr");
    if (button.dataset.act === "edit") startEdit(tr);
    else if (button.dataset.act === "cancel") cancel();
    else if (button.dataset.act === "save") save(tr);
  });

  var addButton = document.getElementById("add-tenant");
  if (addButton) addButton.addEventListener("click", startAdd);

  table.addEventListener("keydown", function (e) {
    if (!open) return;
    if (e.key === "Enter" && e.target.tagName === "INPUT") {
      e.preventDefault();
      save(open.tr);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  });

  /* ---------------------------------------------------- column width & order */

  var status = document.getElementById("layout-status");

  /** The order the table is in right now, read from the headings. */
  function currentOrder() {
    return [].map.call(table.querySelectorAll("thead th[data-col]"), function (th) {
      return th.dataset.col;
    }).filter(function (f) { return f !== "actions"; });
  }
  function colFor(field) {
    return table.querySelector('colgroup col[data-col="' + field + '"]');
  }
  function widthOf(field) {
    return parseInt(colFor(field).style.width, 10);
  }

  /** Put one row's cells into the given order. The actions cell stays last. */
  function orderRow(parent, order) {
    var byField = {};
    [].forEach.call(parent.children, function (el) {
      if (el.dataset.col && el.dataset.col !== "actions") byField[el.dataset.col] = el;
    });
    var last = parent.querySelector('[data-col="actions"]');
    order.forEach(function (field) {
      if (byField[field]) parent.insertBefore(byField[field], last);
    });
  }

  function applyOrder(order) {
    // An open edit holds a snapshot of the row in the old order, so it has to
    // go. A draft has no snapshot — its cells just move with everyone else's,
    // and whatever has been typed into them travels along.
    if (open && open.html !== null) cancel();
    orderRow(table.querySelector("colgroup"), order);
    orderRow(table.querySelector("thead tr"), order);
    [].forEach.call(table.querySelectorAll("tbody tr"), function (tr) { orderRow(tr, order); });
  }

  function setWidth(field, px) {
    if (!isFinite(px)) return;
    px = Math.min(MAX_W, Math.max(MIN_W, Math.round(px)));
    colFor(field).style.width = px + "px";
    retotal();
    return px;
  }

  /** The table is only as wide as its columns, so the total has to be kept up. */
  function retotal() {
    var total = 0;
    [].forEach.call(table.querySelectorAll("colgroup col"), function (col) {
      total += parseInt(col.style.width, 10) || 0;
    });
    table.style.setProperty("--table-width", total + "px");
  }

  function note(message) {
    if (!status) return;
    status.textContent = message || "";
    status.hidden = !message;
  }

  var saveTimer = null;
  function saveLayout() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var columns = currentOrder().map(function (field) {
        return { field: field, width: widthOf(field) };
      });
      fetch("/api/tenant-columns", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ columns: columns })
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (!res.ok) throw new Error(data.error || "Column layout not saved.");
            note("");
          });
        })
        .catch(function (err) { note(err.message + " Your view is right; a reload will lose it."); });
    }, 250);
  }

  function moveColumn(field, delta) {
    var order = currentOrder();
    var from = order.indexOf(field);
    var to = from + delta;
    if (from < 0 || to < 0 || to >= order.length) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    applyOrder(order);
    saveLayout();
  }

  function promptWidth(field) {
    var th = table.querySelector('thead th[data-col="' + field + '"]');
    var label = th ? th.textContent.trim() : field;
    var typed = window.prompt('Width of "' + label + '" in pixels (' + MIN_W + "-" + MAX_W + "):", widthOf(field));
    if (typed === null) return;
    var px = parseInt(typed, 10);
    if (!isFinite(px)) return;
    setWidth(field, px);
    saveLayout();
  }

  function resetColumns() {
    applyOrder(DEFAULT_COLUMNS.map(function (c) { return c.field; }));
    DEFAULT_COLUMNS.forEach(function (c) { setWidth(c.field, c.width); });
    saveLayout();
  }

  /* Drag the right-hand edge of a heading to resize. Pointer events rather
     than mouse ones so the handle answers to a finger or a stylus too, and
     capture so the drag survives the pointer leaving the header — which is
     where a column has to be dragged to make it much wider. */
  var resizing = null;
  table.addEventListener("pointerdown", function (e) {
    var handle = e.target.closest(".resizer");
    if (!handle || e.button !== 0) return;
    e.preventDefault(); // don't let the header start a native drag as well
    var field = handle.closest("th").dataset.col;
    resizing = { field: field, startX: e.clientX, startWidth: widthOf(field), handle: handle };
    handle.classList.add("active");
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing-column");
  });
  table.addEventListener("pointermove", function (e) {
    if (!resizing) return;
    setWidth(resizing.field, resizing.startWidth + (e.clientX - resizing.startX));
  });
  function endResize() {
    if (!resizing) return;
    resizing.handle.classList.remove("active");
    resizing = null;
    document.body.classList.remove("resizing-column");
    saveLayout(); // saved when the drag ends, not on every pixel
  }
  table.addEventListener("pointerup", endResize);
  table.addEventListener("pointercancel", endResize);

  /* double-click the edge for an exact width */
  table.addEventListener("dblclick", function (e) {
    var handle = e.target.closest(".resizer");
    if (!handle) return;
    e.stopPropagation();
    promptWidth(handle.closest("th").dataset.col);
  });

  /* drag a heading sideways to reorder */
  var dragField = null;
  table.addEventListener("dragstart", function (e) {
    var th = e.target.closest("th[data-col]");
    if (!th || th.dataset.col === "actions" || resizing) return;
    dragField = th.dataset.col;
    th.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragField); // Firefox won't drag without it
  });
  table.addEventListener("dragover", function (e) {
    if (dragField === null) return;
    var th = e.target.closest("th[data-col]");
    if (!th || th.dataset.col === "actions") return;
    e.preventDefault();
    clearMarkers();
    if (th.dataset.col === dragField) return;
    var order = currentOrder();
    th.classList.add(order.indexOf(th.dataset.col) > order.indexOf(dragField) ? "drop-after" : "drop-before");
  });
  table.addEventListener("drop", function (e) {
    if (dragField === null) return;
    e.preventDefault();
    var th = e.target.closest("th[data-col]");
    if (th && th.dataset.col !== "actions" && th.dataset.col !== dragField) {
      var order = currentOrder();
      // Landing to the right of the heading you dropped on, or to its left,
      // exactly as the drop-after/drop-before bar promised.
      var after = order.indexOf(th.dataset.col) > order.indexOf(dragField);
      order.splice(order.indexOf(dragField), 1);
      var target = order.indexOf(th.dataset.col);
      order.splice(after ? target + 1 : target, 0, dragField);
      applyOrder(order);
      saveLayout();
    }
    endDrag();
  });
  table.addEventListener("dragend", endDrag);
  function clearMarkers() {
    [].forEach.call(table.querySelectorAll(".drop-before, .drop-after"), function (el) {
      el.classList.remove("drop-before", "drop-after");
    });
  }
  function endDrag() {
    dragField = null;
    clearMarkers();
    [].forEach.call(table.querySelectorAll(".dragging"), function (el) { el.classList.remove("dragging"); });
  }

  /* right-click a heading, for anyone who'd rather not drag */
  var menu = document.getElementById("col-menu");
  table.addEventListener("contextmenu", function (e) {
    var th = e.target.closest("thead th[data-col]");
    if (!th || th.dataset.col === "actions" || !menu) return;
    e.preventDefault();
    var order = currentOrder();
    var at = order.indexOf(th.dataset.col);
    menu.dataset.col = th.dataset.col;
    menu.querySelector('[data-act="left"]').disabled = at === 0;
    menu.querySelector('[data-act="right"]').disabled = at === order.length - 1;
    menu.style.left = e.pageX + "px";
    menu.style.top = e.pageY + "px";
    menu.hidden = false;
  });
  if (menu) {
    menu.addEventListener("click", function (e) {
      var button = e.target.closest("button[data-act]");
      if (!button) return;
      var field = menu.dataset.col;
      menu.hidden = true;
      if (button.dataset.act === "width") promptWidth(field);
      else if (button.dataset.act === "left") moveColumn(field, -1);
      else if (button.dataset.act === "right") moveColumn(field, 1);
      else if (button.dataset.act === "reset") resetColumns();
    });
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !e.target.closest("#col-menu")) menu.hidden = true;
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") menu.hidden = true;
    });
  }

  retotal();
})();`;

/**
 * One table row. Rendered here on first load and again after a save, so the
 * edited row comes back formatted by exactly the same code rather than by a
 * second copy of these rules in the browser.
 *
 * When `canEdit`, the row also carries its raw values as JSON and an Edit
 * button; the editor script turns those into inputs. The button is a
 * convenience only — the write route checks the user itself.
 */
function renderRow(t: any, canEdit: boolean, layout: Column[]): string {
  // The doc records an end date but no start for most tenants, so avoid
  // rendering a dangling arrow. On a vacant unit the date isn't a lease at
  // all — it's when the vacancy ends — so it belongs to the Vacant until
  // column below rather than being printed twice.
  const lease =
    t.status === "vacant"
      ? ""
      : t.lease_start && t.lease_end
        ? `${escapeHtml(t.lease_start)} &rarr; ${escapeHtml(t.lease_end)}`
        : t.lease_end
          ? `ends ${escapeHtml(t.lease_end)}`
          : t.lease_start
            ? `from ${escapeHtml(t.lease_start)}`
            : "";

  const cells: Record<string, string> = {
    property: escapeHtml(t.property_address),
    unit: escapeHtml(t.unit),
    access: renderAccess(t),
    status: `<span class="status ${escapeHtml(t.status)}">${escapeHtml(t.status)}</span>`,
    // Only a vacant unit has a vacancy to end; on anyone else lease_end is the
    // end of their lease, which this column would misread as a move-in date.
    vacant_until:
      t.status === "vacant" && t.lease_end ? escapeHtml(t.lease_end) : "",
    name: `${escapeHtml(t.first_name)} ${escapeHtml(t.last_name)}${
      isSampleTenant(t) ? ' <span class="tag">sample</span>' : ""
    }`,
    email: escapeHtml(t.email),
    phone: escapeHtml(t.phone),
    lease,
    rent: t.rent_amount ? "$" + t.rent_amount : "",
  };

  const raw = Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, t[f]]));
  const editable = canEdit
    ? ` data-id="${t.id}" data-tenant="${escapeAttr(JSON.stringify(raw))}"`
    : "";
  const actions = canEdit
    ? `\n        <td data-col="actions" data-label="Edit" class="row-actions"><button type="button" data-act="edit">Edit</button></td>`
    : "";

  // data-col is what the editor and the layout script address cells by;
  // data-label is the heading the mobile card view prints beside each value.
  const tds = layout
    .map((c) => `\n        <td data-col="${c.field}" data-label="${escapeAttr(c.label)}">${cells[c.field]}</td>`)
    .join("");

  return `
      <tr${isSampleTenant(t) ? ' class="sample"' : ""}${editable}>${tds}${actions}
      </tr>`;
}

/** The Google Docs export the home details are read out of, on every load. */
const HOME_DOC = "home-unit-information.html";

/**
 * Addresses as written by two different hands: the document heads a section
 * "12 Example Ave NE #L (Lower part of Duplex)", the table stores "12 Example
 * Ave NE" with "#L" in its own column. Stripping to letters and digits lets
 * one be recognised as the start of the other.
 */
const addressKey = (value: string) =>
  String(value ?? "")
    .replace(/\(.*$/, "") // the parenthetical a doc heading carries
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/**
 * The door codes for one property, as a strip under its heading. The table at
 * the top of the page is the list to scan; this is the answer to "I am outside
 * this building, what do I type", which is the reason the section gets opened
 * at all.
 *
 * Units are matched to a section by address, so a property nobody has a code
 * for prints nothing rather than an empty heading.
 */
function accessCodesFor(title: string, tenants: any[]): string {
  const section = addressKey(title);
  const units = tenants.filter((t) => {
    const key = addressKey(t.property_address);
    return key.length > 6 && section.startsWith(key);
  });
  if (!units.length) return "";

  // A building code is shared, so it's said once rather than on every unit.
  const building = units.find((t) => t.building_code)?.building_code ?? "";
  const withCodes = units.filter((t) => t.access_code);
  if (!withCodes.length && !building) return "";

  const pills = withCodes
    .map((t) => {
      const unit = String(t.unit ?? "").trim();
      return `<span class="code-pill">${
        unit ? `<span class="u">${escapeHtml(unit)}</span>` : ""
      }<span class="c">${escapeHtml(t.access_code)}</span></span>`;
    })
    .join("");

  return `<div class="codes">
        <span class="codes-label">Access</span>
        ${pills}
        ${building ? `<span class="code-pill bldg"><span class="u">building</span><span class="c">${escapeHtml(building)}</span></span>` : ""}
      </div>`;
}

/**
 * The Home/Unit Information export, or nothing if the file has gone missing —
 * the access table is the half of this page people are looking at when a door
 * won't open, so it still renders when the document doesn't.
 */
async function loadHomeSections(): Promise<Section[]> {
  const file = Bun.file(HOME_DOC);
  if (!(await file.exists())) {
    console.warn(`${HOME_DOC} is missing; rendering the page without the home details.`);
    return [];
  }
  try {
    return docSections(await file.text());
  } catch (err) {
    console.warn(`Could not read ${HOME_DOC}; rendering the page without the home details.`, err);
    return [];
  }
}

async function renderPage(user: User): Promise<string> {
  const canEdit = canEditTenants(user);
  const layout = loadColumnLayout();
  const tenants = db.query("SELECT * FROM tenants ORDER BY property_address, unit, last_name").all() as any[];
  const sampleCount = tenants.filter(isSampleTenant).length;

  // Rented units go to a section of their own at the foot of the table, folded
  // away until someone asks for them. Both halves keep the query's order.
  const rows = tenants
    .filter((t) => t.status !== HIDDEN_STATUS)
    .map((t) => renderRow(t, canEdit, layout))
    .join("");
  const hiddenTenants = tenants.filter((t) => t.status === HIDDEN_STATUS);
  const hiddenRows = hiddenTenants.map((t) => renderRow(t, canEdit, layout)).join("");

  const columnCount = layout.length + (canEdit ? 1 : 0);
  const tableWidth =
    layout.reduce((sum, c) => sum + c.width, 0) + (canEdit ? ACTIONS_WIDTH : 0);
  const cols =
    layout
      .map((c) => `<col data-col="${c.field}" style="width:${c.width}px" />`)
      .join("") + (canEdit ? `<col data-col="actions" style="width:${ACTIONS_WIDTH}px" />` : "");

  // The document half of the page: the properties, then whatever else the
  // export carries (Application, FAQ), each in the order the doc has them.
  const sections = await loadHomeSections();
  const homes = sections.filter(isProperty);
  const rest = sections.filter((s) => !isProperty(s));

  // Contents: the access table, every home, then the sections after them. The
  // cards below cover the homes again with more to read — this is the short
  // list, and the only place the tail sections are linked from.
  const toc = [
    `<a href="#access">Access table</a>`,
    ...sections.map((s) => `<a href="#${s.id}">${escapeHtml(s.title)}</a>`),
  ].join("");

  const cards = homes
    .map(
      (s) => `<a class="card" href="#${s.id}">
        <div class="name">${escapeHtml(s.title)}</div>
        <div class="desc">${escapeHtml(describeProperty(s))}</div></a>`
    )
    .join("");

  // Only an editor gets the drag handles; everyone else gets plain headings.
  const headings =
    layout
      .map((c) =>
        canEdit
          ? `<th data-col="${c.field}" draggable="true" title="Drag to reorder; drag or double-click the edge to resize; right-click for more">` +
            `${escapeHtml(c.label)}<span class="resizer"></span></th>`
          : `<th data-col="${c.field}">${escapeHtml(c.label)}</th>`
      )
      .join("") + (canEdit ? `<th data-col="actions"></th>` : "");

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Tenants, Access &amp; Homes</title>
  ${FAVICON_LINK}
  <style>
${NAV_CSS}
${DOC_CSS}

    /* The two halves of this page were two pages until they were merged, and
       they still carry their own styling. Everything the access table brings
       is scoped to #access below, because the bare table/th/td rules it used
       to rely on would otherwise restyle the unit tables inside the home
       sections — which are the document's, and already styled as table.units. */

    .page { max-width: 1180px; margin: 0 auto; padding: 0 1.5rem 4rem; }
    .page > h1 { font-size: 1.9rem; letter-spacing: -0.02em; margin: 0 0 0.35rem; }
    .page > .lede { margin: 0 0 1.5rem; color: var(--muted); font-size: 0.9rem; }
    h2.band { font-size: 1.1rem; margin: 2.25rem 0 0.9rem; letter-spacing: -0.01em; }

    /* Contents, across the top rather than down the side: this page is read
       from the top when someone needs a code, not browsed section by section. */
    .contents { background: #fff; border: 1px solid var(--line); border-radius: 10px;
      padding: 0.85rem 1rem; margin-bottom: 1.75rem; }
    .contents h2 { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--muted); margin: 0 0 0.55rem; }
    .contents .links { display: flex; flex-wrap: wrap; gap: 0.3rem; }
    .contents a { padding: 0.28rem 0.6rem; border-radius: 6px; color: #374151; text-decoration: none;
      font-size: 0.86rem; background: #f4f6f9; }
    .contents a:hover { background: #e8effc; color: var(--accent); }

    /* The table is exactly as wide as its columns add up to, and scrolls
       sideways inside this wrapper rather than squeezing them. */
    #access .table-wrap { margin: 0; overflow-x: auto; border: 0; border-radius: 0; }
    #access table { border-collapse: collapse; table-layout: fixed; width: var(--table-width, 100%);
      background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); font-family: system-ui, sans-serif; }
    #access th, #access td { text-align: left; padding: 0.6rem 0.8rem; border-bottom: 1px solid #eee;
      font-size: 0.9rem; overflow-wrap: break-word; }
    #access th { background: #f2f2f2; font-weight: 600; position: relative; }
    #access tbody tr:hover { background: #f9f9f9; }

    /* Door codes under a property's heading. Monospaced and set larger than
       the prose around them: this is read off a screen while standing at a
       door, often one-handed, and a mistyped digit means a locked-out tenant. */
    .codes { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem;
      margin: 0 0 1.15rem; padding: 0.7rem 0.85rem; background: #f7f9fc;
      border: 1px solid var(--line); border-left: 3px solid var(--accent); border-radius: 8px; }
    .codes-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.07em;
      color: var(--muted); font-weight: 600; margin-right: 0.15rem; }
    .code-pill { display: inline-flex; align-items: baseline; gap: 0.35rem; background: #fff;
      border: 1px solid #dbe1ea; border-radius: 6px; padding: 0.15rem 0.5rem; }
    .code-pill .u { font-size: 0.72rem; color: var(--muted); }
    .code-pill .c { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 1rem;
      font-weight: 600; letter-spacing: 0.05em; color: var(--ink); }
    .code-pill.bldg { background: #eef2fb; border-color: #ccd8f0; }

    .notice { margin: 0 0 1rem; padding: 0.6rem 0.85rem; background: #fff8e1; border: 1px solid #f0d68a;
      border-left-width: 3px; border-radius: 6px; font-size: 0.85rem; color: #6b5300; line-height: 1.5; }
    .notice code { background: rgba(0,0,0,0.05); padding: 0 0.2rem; border-radius: 3px; }

    .code-unit { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.95rem;
      letter-spacing: 0.04em; display: block; }
    .code-building { display: block; font-size: 0.7rem; color: #888; letter-spacing: 0.02em; }

    #access tr.sample td { color: #8a8a8a; }
    .tag { display: inline-block; margin-left: 0.35rem; padding: 0.05rem 0.35rem; border-radius: 3px;
      background: #f0d68a; color: #6b5300; font-size: 0.68rem; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.03em; vertical-align: middle; }

    /* Column width & order (Dan only — see canEditTenants) */
    #access th[draggable="true"] { cursor: grab; user-select: none; }
    /* Wider than the line it draws and straddling the boundary, so the edge is
       catchable without aiming at it; it shows itself when the header is
       hovered rather than sitting there all the time. Matches the grid on the
       sheet pages. */
    #access th .resizer { position: absolute; top: 0; right: -6px; width: 13px; height: 100%;
      cursor: col-resize; z-index: 2; touch-action: none; }
    #access th .resizer::after { content: ""; position: absolute; left: 6px; top: 18%; bottom: 18%;
      width: 1px; background: transparent; transition: background 0.1s, width 0.1s; }
    #access th:hover .resizer::after { background: #c9cdd2; }
    #access th .resizer:hover::after, #access th .resizer.active::after {
      background: #2563eb; width: 2px; left: 5px; }
    /* The last heading's handle stays inside it, so it can't add a few pixels
       of empty sideways scroll to the table. */
    #access th:last-child .resizer { right: 0; }
    #access th:last-child .resizer::after { left: 11px; }
    body.resizing-column { cursor: col-resize; user-select: none; }
    #access th.dragging { opacity: 0.45; }
    /* where the dragged column will land */
    #access th.drop-before { box-shadow: inset 3px 0 0 #2563eb; }
    #access th.drop-after { box-shadow: inset -3px 0 0 #2563eb; }

    .layout-hint { margin: 0.6rem 0 0; font-size: 0.78rem; color: #8a8a8a; }
    .layout-error { margin: 0.5rem 0 0; font-size: 0.8rem; color: #991b1b; }
    .col-menu { position: absolute; z-index: 20; background: #fff; border: 1px solid #d1d5db;
      border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.18); padding: 4px 0; min-width: 12rem; }
    .col-menu button { display: block; width: 100%; text-align: left; background: none; border: 0;
      padding: 0.4rem 0.9rem; font: inherit; font-size: 0.85rem; color: #1a1a1a; cursor: pointer; }
    .col-menu button:hover:not([disabled]) { background: #f3f4f6; }
    .col-menu button[disabled] { color: #b0b0b0; cursor: default; }

    /* Editing (Dan only — see canEditTenants) */
    .table-tools { margin: 0 0 0.6rem; }
    .table-tools button { background: #1f2937; color: #fff; border: 0; border-radius: 6px;
      padding: 0.4rem 0.8rem; font: 600 0.82rem system-ui, sans-serif; cursor: pointer; }
    .table-tools button:hover { background: #374151; }
    #access tr[data-draft] td { background: #f7faff; }
    .row-actions { white-space: nowrap; text-align: right; }
    .row-actions button { background: #fff; border: 1px solid #d1d5db; border-radius: 5px; padding: 0.25rem 0.6rem;
      font: 500 0.78rem system-ui, sans-serif; color: #374151; cursor: pointer; }
    .row-actions button:hover { background: #f3f4f6; }
    .row-actions button[data-act="save"] { background: #1f2937; border-color: #1f2937; color: #fff; }
    .row-actions button[data-act="save"]:hover { background: #374151; }
    .row-actions button[disabled] { opacity: 0.6; cursor: default; }
    tr.editing { background: #f7faff; }
    tr.editing td { vertical-align: top; }
    tr.editing input, tr.editing select { width: 100%; min-width: 4.5rem; padding: 0.3rem 0.4rem; margin: 0 0 0.2rem;
      border: 1px solid #d1d5db; border-radius: 5px; font: inherit; font-size: 0.85rem; background: #fff; }
    tr.editing input:focus, tr.editing select:focus { outline: 2px solid #60a5fa; outline-offset: -1px; border-color: transparent; }
    tr.editing input:last-child { margin-bottom: 0; }
    .field-error { display: block; margin-top: 0.3rem; color: #991b1b; font-size: 0.75rem; white-space: normal; }

    #access .status { padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.78rem;
      text-transform: capitalize; white-space: nowrap; }
    #access .status.active { background: #e3f6e5; color: #1e7d32; }
    #access .status.past { background: #f0f0f0; color: #666; }
    #access .status.pending { background: #fff4e0; color: #a15c00; }
    #access .status.vacant { background: #e8eefc; color: #2b4a9b; }
    #access .status.rented { background: #ede9fe; color: #5b21b6; }

    /* The collapsed "Rented" section at the foot of the table */
    #access .section-toggle td { padding: 0; border-bottom: 0; }
    #toggle-rented { display: flex; align-items: center; gap: 0.45rem; width: 100%;
      background: #fafafa; border: 0; border-top: 1px solid #eee; padding: 0.6rem 0.85rem;
      font: 600 0.82rem system-ui, sans-serif; color: #444; cursor: pointer; text-align: left; }
    #toggle-rented:hover { background: #f3f4f6; }
    #toggle-rented .chev { display: inline-block; color: #888; transition: transform 0.12s ease; }
    #toggle-rented[aria-expanded="true"] .chev { transform: rotate(90deg); }
    #toggle-rented .count { background: #ede9fe; color: #5b21b6; border-radius: 999px;
      padding: 0.05rem 0.45rem; font-size: 0.75rem; }
    #rented-rows td { background: #fcfcfd; }

    /* Stack the access table into cards on narrow screens. Only that table —
       the unit tables in the home sections scroll sideways instead, which is
       what a two-column price list wants. */
    @media (max-width: 640px) {
      .page { padding: 0 0.75rem 2.5rem; }
      .page > h1 { font-size: 1.35rem; }
      #access table, #access thead, #access tbody, #access th, #access td, #access tr { display: block; }
      #access thead, #access colgroup { display: none; }
      /* Cards, so the column widths and the sideways scroll don't apply. */
      #access .table-wrap { overflow-x: visible; }
      #access table { box-shadow: none; background: transparent; width: 100%; table-layout: auto; }
      .layout-hint, .col-menu { display: none; }
      #access tr {
        background: white;
        border-radius: 8px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        margin-bottom: 0.75rem;
        padding: 0.5rem 0.8rem;
      }
      #access td {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.75rem;
        padding: 0.5rem 0;
        border-bottom: 1px solid #f0f0f0;
        text-align: right;
      }
      #access td:last-child { border-bottom: none; }
      #access td::before {
        content: attr(data-label);
        font-weight: 600;
        color: #666;
        text-align: left;
      }
      /* The fold is a bar between the cards, not a card of its own. */
      #access .section-toggle tr { background: transparent; box-shadow: none; padding: 0; margin-bottom: 0.75rem; }
      #access .section-toggle td { display: block; padding: 0; }
      #toggle-rented { border-top: 0; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    }
  </style>
</head>
<body>
  ${renderNav("/", user)}
  <div class="page">
  <h1>Tenants, Access &amp; Homes</h1>
  <p class="lede">Door codes and who is in each unit, then the details of every home &mdash;
    ${homes.length} ${homes.length === 1 ? "property" : "properties"}, the application and the FAQ.</p>

  <nav class="contents" aria-label="Contents">
    <h2>Contents</h2>
    <div class="links">${toc}</div>
  </nav>

  <section id="access">
  <h2 class="band">Access table</h2>
  ${
    sampleCount > 0
      ? `<p class="notice"><strong>${sampleCount} placeholder ${
          sampleCount === 1 ? "row is" : "rows are"
        } not real tenants</strong> — tagged <span class="tag">sample</span> below.
         They use <code>@example.com</code> addresses and <code>555-01xx</code> numbers, and were
         seeded when the table was created. Safe to delete; see the README.</p>`
      : ""
  }
  ${canEdit ? `<p class="table-tools"><button type="button" id="add-tenant">+ Add tenant</button></p>` : ""}
  <div class="table-wrap">
    <table id="access-table" style="--table-width:${tableWidth}px">
      <colgroup>${cols}</colgroup>
      <thead>
        <tr>${headings}</tr>
      </thead>
      <tbody>
        ${
          tenants.length === 0
            ? `<tr class="empty-row"><td colspan="${columnCount}">No tenants yet.</td></tr>`
            : rows
        }
      </tbody>
      <tbody class="section-toggle"${hiddenTenants.length ? "" : " hidden"}>
        <tr>
          <td colspan="${columnCount}">
            <button type="button" id="toggle-rented" aria-expanded="false" aria-controls="rented-rows">
              <span class="chev" aria-hidden="true">&#9656;</span>
              Rented <span class="count">${hiddenTenants.length}</span>
            </button>
          </td>
        </tr>
      </tbody>
      <tbody id="rented-rows" hidden>
        ${hiddenRows}
      </tbody>
    </table>
  </div>
  <script>${TOGGLE_JS}</script>
  ${
    canEdit
      ? `<p class="layout-hint">Drag a heading to reorder &middot; drag or double-click its right edge to resize
         &middot; right-click for more. The layout is saved for everyone.</p>
  <p class="layout-error" id="layout-status" hidden></p>
  <div class="col-menu" id="col-menu" hidden>
    <button type="button" data-act="width">Column width&hellip;</button>
    <button type="button" data-act="left">Move column left</button>
    <button type="button" data-act="right">Move column right</button>
    <button type="button" data-act="reset">Reset all columns</button>
  </div>
  <script>${PAGE_JS}</script>`
      : ""
  }
  </section>

  ${
    sections.length
      ? `<h2 class="band" id="homes">Home details</h2>
  <div class="cards">${cards}</div>
  ${homes.map((s) => sectionHtml(s, accessCodesFor(s.title, tenants))).join("\n")}
  ${rest.map((s) => sectionHtml(s)).join("\n")}`
      : `<p class="notice">The Home/Unit Information document isn't available right now.</p>`
  }
  </div>
</body>
</html>`;
}

/**
 * Only these two came out of the Google Sheet; Vendors was started here, so
 * pointing at that spreadsheet from its page would be a lie.
 */
const IMPORTED_SHEETS = new Set(["tours", "leases"]);
const SOURCE_LINK =
  `<a class="src" href="https://docs.google.com/spreadsheets/d/1Be1wPhnN6BwqeFja7RkI1-NC0F1M4h9_dErFR1U8tMk/edit"` +
  ` target="_blank" rel="noopener">Imported from Google Sheets &#8599;</a>`;

/**
 * The spreadsheet page, once per sheet. `public/sheets.html` is the same file
 * for all of them; the nav, the page title and which sheet to open are stamped
 * into it here, so the grid doesn't have to know how the bar is built.
 */
async function renderSheet(user: User, sheetId: string): Promise<Response> {
  const sheets = listSheetTabs.all() as SheetTab[];
  const sheet = sheets.find((s) => s.id === sheetId);
  if (!sheet) {
    // A renamed or deleted sheet shouldn't 404 a bookmark.
    return new Response(null, {
      status: 303,
      headers: { Location: sheets.length ? `/sheets/${sheets[0].id}` : "/", "Cache-Control": "no-store" },
    });
  }

  const file = Bun.file("public/sheets.html");
  if (!(await file.exists())) return new Response("Sheet page not found", { status: 404 });

  const html = (await file.text())
    .replace("<!--NAV_LINKS-->", navLinksHtml(`/sheets/${sheet.id}`))
    .replace("<!--NAV_SOURCE-->", IMPORTED_SHEETS.has(sheet.id) ? SOURCE_LINK : "")
    .replace("<!--NAV_USER-->", navUserHtml(user))
    .replaceAll("__ACTIVE_SHEET__", escapeAttr(sheet.id))
    .replaceAll("__SHEET_NAME__", escapeHtml(sheet.name));

  return new Response(html, { headers: HTML_HEADERS });
}

/**
 * The Google Docs exports, re-rendered as clean pages (see doc.ts). Re-export a
 * doc over its file and the page follows on the next load.
 */
async function renderExportedDoc(
  path: string,
  render: (html: string, nav: string, navCss: string) => string,
  navHref: string,
  user: User
): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) return new Response("Document not found", { status: 404 });
  return new Response(render(await file.text(), renderNav(navHref, user), NAV_CSS), {
    headers: HTML_HEADERS,
  });
}

type SheetRow = {
  id: string; name: string; position: number; columns: string; rows: string; rev: number;
};

function loadSheets() {
  const rows = db
    .query("SELECT id, name, position, columns, rows, rev FROM sheets ORDER BY position, id")
    .all() as SheetRow[];
  return {
    sheets: rows.map((s) => ({
      id: s.id,
      name: s.name,
      columns: JSON.parse(s.columns),
      rows: JSON.parse(s.rows),
      rev: s.rev,
    })),
  };
}

const upsertSheet = db.prepare(
  `INSERT INTO sheets (id, name, position, columns, rows, rev) VALUES (?, ?, ?, ?, ?, 1)
   ON CONFLICT(id) DO UPDATE SET
     name = excluded.name, columns = excluded.columns, rows = excluded.rows,
     rev = sheets.rev + 1, updated_at = CURRENT_TIMESTAMP`
);

const readSheetMeta = db.prepare(`SELECT rev, position FROM sheets WHERE id = ?`);
const nextPosition = db.prepare(`SELECT COALESCE(MAX(position), -1) + 1 AS next FROM sheets`);
const recordVersion = db.prepare(
  `INSERT INTO sheet_versions (sheet_id, rev, columns, rows, row_count, saved_by)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const pruneVersions = db.prepare(
  `DELETE FROM sheet_versions WHERE sheet_id = ? AND id NOT IN
     (SELECT id FROM sheet_versions WHERE sheet_id = ? ORDER BY id DESC LIMIT ?)`
);

/**
 * Saves the sheets a page actually edited, and only if that page is up to date.
 *
 * Two rules, both of them the lesson from the 2026-08-05 data loss (see db.ts):
 * a save carries the `rev` its page loaded with and is refused outright if the
 * stored rev has moved on, and a save touches only the sheets it names — a page
 * showing Tours can't write back its stale idea of Leases and Vendors, which is
 * what the old whole-document PUT did on every keystroke and on tab close.
 *
 * Refusing is all-or-nothing: if any sheet in the request is stale, none of it
 * is written, so a rejected save never lands half-applied.
 */
const saveSheets = db.transaction((sheets: any[], savedBy: string) => {
  const stale: string[] = [];
  for (const s of sheets) {
    const meta = readSheetMeta.get(s.id) as { rev: number; position: number } | undefined;
    // An unknown id is a new sheet, which nobody can be behind on.
    if (meta && s.rev !== meta.rev) stale.push(s.id);
  }
  if (stale.length) return { stale };

  const saved: Record<string, number> = {};
  for (const s of sheets) {
    const meta = readSheetMeta.get(s.id) as { rev: number; position: number } | undefined;
    const position = meta ? meta.position : (nextPosition.get() as { next: number }).next;
    const columns = JSON.stringify(s.columns);
    const rows = JSON.stringify(s.rows);
    upsertSheet.run(s.id, s.name, position, columns, rows);
    const rev = (readSheetMeta.get(s.id) as { rev: number }).rev;
    recordVersion.run(s.id, rev, columns, rows, s.rows.length, savedBy);
    pruneVersions.run(s.id, s.id, SHEET_VERSIONS_KEPT);
    saved[s.id] = rev;
  }
  return { stale: [], revs: saved };
});

/**
 * Re-renders the plates page with something to say, keeping the user on the
 * form. An `error` is something they must fix; a `notice` is the page working
 * as intended — a car refused because it is on the allowed list.
 */
function platesPage(user: User, error?: string, notice?: string): Response {
  return new Response(renderPlatesPage(renderNav("/plates", user), NAV_CSS, error, notice), {
    status: error ? 400 : 200,
    headers: HTML_HEADERS,
  });
}

/** The Tours & Prospects sheet, the only one that books anything. */
const TOURS_SHEET_ID = "tours";

/**
 * Books calendar events for tours added by the save that just landed.
 *
 * Detached from the response on purpose. Nothing here is allowed to fail the
 * request or slow it down: the queue row is written synchronously so a crash
 * between here and the post still leaves the tour to be picked up, and the
 * post itself happens on the retry loop's terms.
 */
function queueTourEvents(
  sheets: any[],
  previous: { rows: string } | undefined,
  username: string
) {
  const tours = sheets.find((s: any) => s.id === TOURS_SHEET_ID);
  if (!tours) return;
  try {
    const before = previous ? (JSON.parse(previous.rows) as any[][]) : [];
    const { created, updated, vanished } = enqueueNewTours(
      before,
      tours.rows,
      tours.columns,
      username
    );
    const when = (e: { start?: string; allDayOn?: string }) =>
      e.start ?? `${e.allDayOn} (all day)`;

    for (const e of created) {
      console.log(
        `[${new Date().toISOString()}] tour queued for calendar by ${username}: ` +
          `"${e.title}" ${when(e)}` +
          (e.unknownGuides.length
            ? ` — no email on file for ${e.unknownGuides.join(", ")}, invited the office only`
            : "")
      );
    }
    for (const e of updated) {
      console.log(
        `[${new Date().toISOString()}] tour edited by ${username}, updating its event: ` +
          `"${e.title}" ${when(e)}`
      );
    }
    for (const e of vanished) {
      // Left deliberately: see enqueueNewTours. Logged so a row deleted by
      // accident doesn't leave an invitation nobody can account for.
      console.log(
        `[${new Date().toISOString()}] tour removed from the sheet by ${username}, ` +
          `its calendar event was left in place: "${e.title}" ${when(e)}`
      );
    }
    if (created.length || updated.length) void flushQueue();
  } catch (err) {
    // A malformed row must never cost somebody their save.
    console.error(`[${new Date().toISOString()}] queueing tour events failed:`, err);
  }
}

function validSheet(s: any): boolean {
  return (
    s && typeof s.id === "string" && typeof s.name === "string" &&
    Array.isArray(s.columns) && Array.isArray(s.rows) &&
    s.rows.every((r: any) => Array.isArray(r)) &&
    // The rev the page loaded with. Required: a save that can't say what it is
    // based on is exactly the save that used to lose people's work.
    Number.isInteger(s.rev)
  );
}

/**
 * Everything this app serves is tenant PII, so nothing is cached anywhere
 * between us and the browser, and no page is allowed into a frame.
 */
const HTML_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store, private",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
} as const;

const userCount = accountCount();
if (userCount === 0) {
  console.warn(
    "\nNo accounts exist yet. Open http://localhost:3000 on this machine to\n" +
      'create the first one, or run: bun run users add <username> --name "Your Name"\n'
  );
}

const server = Bun.serve({
  // Defaults to loopback. Set HOST=0.0.0.0 to let the team reach it over the
  // network — but read the README's note on HTTPS first: over plain http://,
  // passwords and session cookies cross the network in the clear.
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? "127.0.0.1",
  async fetch(req, server) {
    const url = new URL(req.url);
    const ip = server.requestIP(req)?.address ?? "unknown";

    // The tab icon, above everything else: it's wanted by the sign-in and setup
    // pages too, and it's the one thing this app serves that isn't somebody's
    // personal information — so it's also the one response allowed to be
    // cached. `/favicon.ico` is where a browser looks unasked; every page also
    // points at the .svg explicitly.
    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
      const icon = Bun.file("public/favicon.svg");
      if (!(await icon.exists())) return new Response("Not found", { status: 404 });
      return new Response(icon, {
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=86400" },
      });
    }

    // Before any account exists there is nothing to sign in to, so send this
    // machine to setup and tell everyone else the app doesn't exist.
    if (accountCount() === 0) {
      if (!isLoopback(ip)) return new Response("Not found", { status: 404 });
      if (url.pathname === "/setup") {
        if (req.method === "GET") return new Response(renderSetup(), { headers: PAGE_HEADERS });
        if (req.method === "POST") return await handleSetup(req);
        return new Response("Method not allowed", { status: 405 });
      }
      return new Response(null, { status: 303, headers: { Location: "/setup", "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/setup") {
      return new Response(null, { status: 303, headers: { Location: "/login", "Cache-Control": "no-store" } });
    }

    // The only routes reachable without a session.
    if (url.pathname === "/register") {
      if (req.method === "GET") {
        return new Response(
          renderRegister(undefined, {
            username: url.searchParams.get("u") ?? "",
            code: url.searchParams.get("code") ?? "",
          }),
          { headers: PAGE_HEADERS }
        );
      }
      if (req.method === "POST") return await handleRegister(req, ip);
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/login") {
      if (req.method === "GET") {
        return new Response(renderLogin(undefined, url.searchParams.get("next") ?? "/"), {
          headers: PAGE_HEADERS,
        });
      }
      if (req.method === "POST") return await handleLogin(req, ip);
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/logout") {
      return handleLogout(req);
    }

    const user = authenticate(req);
    if (user instanceof Response) return user;

    if (url.pathname === "/") {
      return new Response(await renderPage(user), { headers: HTML_HEADERS });
    }
    // The home details moved under the access table; old links and bookmarks
    // land on that half of the merged page rather than 404.
    if (url.pathname === "/doc") {
      return new Response(null, {
        status: 303,
        headers: { Location: "/#homes", "Cache-Control": "no-store" },
      });
    }
    if (url.pathname === "/workflow") {
      return await renderExportedDoc(
        "prospect-management-workflow.html",
        renderWorkflowPage,
        "/workflow",
        user
      );
    }
    // The signed move-in checklists, read out of the checklist app's own
    // database (see inspections.ts). Read-only, and everyone signed in can see
    // them: a walkthrough is a record of the property, not something only Dan
    // has business reading.
    if (url.pathname === "/inspections") {
      return new Response(renderInspectionsList(renderNav("/inspections", user), NAV_CSS), {
        headers: HTML_HEADERS,
      });
    }
    // Both of these come off the checklist app's disk, so the team never has to
    // reach :3100 themselves — this app is the one behind the sign-in.
    const inspectionPdf = url.pathname.match(/^\/inspections\/([0-9a-f-]{36})\.pdf$/);
    if (inspectionPdf) {
      if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
      // ?original=1 is the document as it was signed, with no addendum on it.
      return await serveInspectionPdf(inspectionPdf[1], url.searchParams.get("original") === "1");
    }
    const inspectionUpload = url.pathname.match(/^\/inspections\/uploads\/([0-9a-f-]{36}\.[a-z0-9]{2,5})$/);
    if (inspectionUpload) {
      if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return await serveInspectionUpload(inspectionUpload[1]);
    }
    const inspectionPage = url.pathname.match(/^\/inspections\/([0-9a-f-]{36})$/);
    if (inspectionPage) {
      const html = renderInspection(inspectionPage[1], user, renderNav("/inspections", user), NAV_CSS);
      if (!html) return new Response("That inspection doesn't exist.", { status: 404 });
      return new Response(html, { headers: HTML_HEADERS });
    }

    /**
     * Comments on a signed inspection. Anyone signed in may add one — the
     * people who walk the properties are the ones who know what happened
     * afterwards — and it goes out attributed to them. Removing one is limited
     * to whoever wrote it (or Dan), inside deleteInspectionNote.
     *
     * These write to the CRM's own database. Nothing here touches the signed
     * checklist or its PDF on disk; the comments print as an addendum after the
     * signed pages when the PDF is served.
     */
    const inspectionNotes = url.pathname.match(/^\/api\/inspections\/([0-9a-f-]{36})\/notes$/);
    if (inspectionNotes) {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "expected a JSON body" }, { status: 400 });
      }
      const result = addInspectionNote(inspectionNotes[1], user, body?.body);
      if ("error" in result) {
        return Response.json({ error: result.error }, { status: result.status, headers: { "Cache-Control": "no-store" } });
      }
      return Response.json(
        { ok: true, note: renderNote(result.note, user) },
        { status: 201, headers: { "Cache-Control": "no-store, private" } }
      );
    }

    const inspectionNote = url.pathname.match(/^\/api\/inspections\/([0-9a-f-]{36})\/notes\/(\d+)$/);
    if (inspectionNote) {
      if (req.method !== "DELETE") return new Response("Method not allowed", { status: 405 });
      const result = deleteInspectionNote(inspectionNote[1], Number(inspectionNote[2]), user);
      if ("error" in result) {
        return Response.json({ error: result.error }, { status: result.status, headers: { "Cache-Control": "no-store" } });
      }
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    // Each sheet is its own page now. The bare /sheets of the old single-page
    // version still works, and lands on the first tab.
    if (url.pathname === "/sheets") {
      const first = (listSheetTabs.all() as SheetTab[])[0];
      return new Response(null, {
        status: 303,
        headers: { Location: first ? `/sheets/${first.id}` : "/", "Cache-Control": "no-store" },
      });
    }
    const sheetPage = url.pathname.match(/^\/sheets\/([A-Za-z0-9_-]+)$/);
    if (sheetPage) {
      return await renderSheet(user, sheetPage[1]);
    }
    if (url.pathname === "/api/tenants") {
      if (req.method === "GET") {
        const tenants = db.query("SELECT * FROM tenants ORDER BY last_name, first_name").all();
        return Response.json(tenants, { headers: { "Cache-Control": "no-store, private" } });
      }
      // Adding a tenant. Same rule and same validation as editing one — a new
      // row just doesn't have an id yet.
      if (req.method === "POST") {
        if (!canEditTenants(user)) {
          console.warn(
            `[${new Date().toISOString()}] REJECTED tenant add by ${user.username} — not an editor`
          );
          return Response.json(
            { error: "Only Dan can add tenants. Ask him to make the change." },
            { status: 403, headers: { "Cache-Control": "no-store" } }
          );
        }

        let body: any;
        try {
          body = await req.json();
        } catch {
          return Response.json({ error: "expected a JSON body" }, { status: 400 });
        }

        const checked = validateTenant(body);
        if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });

        const created = insertTenant.get(...checked.values) as { id: number };
        const row = db.query("SELECT * FROM tenants WHERE id = ?").get(created.id) as any;
        console.log(
          `[${new Date().toISOString()}] tenant ${created.id} (${row.first_name} ${row.last_name}) ` +
            `added by ${user.username}`
        );
        return Response.json(
          { ok: true, row: renderRow(row, true, loadColumnLayout()) },
          { status: 201, headers: { "Cache-Control": "no-store, private" } }
        );
      }
      return new Response("Method not allowed", { status: 405 });
    }

    // Editing a tenant row. Everyone signed in can read the table; only the
    // account named in canEditTenants can change it, and that is decided here
    // rather than by whether the page drew an Edit button.
    const tenantEdit = url.pathname.match(/^\/api\/tenants\/(\d+)$/);
    if (tenantEdit) {
      if (req.method !== "PUT") return new Response("Method not allowed", { status: 405 });
      if (!canEditTenants(user)) {
        console.warn(
          `[${new Date().toISOString()}] REJECTED tenant edit by ${user.username} — not an editor`
        );
        return Response.json(
          { error: "Only Dan can edit tenants. Ask him to make the change." },
          { status: 403, headers: { "Cache-Control": "no-store" } }
        );
      }

      const id = Number(tenantEdit[1]);
      if (!db.query("SELECT 1 FROM tenants WHERE id = ?").get(id)) {
        return Response.json({ error: "That tenant no longer exists — reload the page." }, { status: 404 });
      }

      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "expected a JSON body" }, { status: 400 });
      }

      const checked = validateTenant(body);
      if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });

      updateTenant.run(...checked.values, id);
      const row = db.query("SELECT * FROM tenants WHERE id = ?").get(id) as any;
      const layout = loadColumnLayout();
      console.log(
        `[${new Date().toISOString()}] tenant ${id} (${row.first_name} ${row.last_name}) edited by ${user.username}`
      );
      return Response.json(
        { ok: true, row: renderRow(row, true, layout) },
        { headers: { "Cache-Control": "no-store, private" } }
      );
    }

    // The shared column layout. Same rule as editing rows: everyone sees it,
    // only Dan sets it — so a change here changes the page for the whole team.
    if (url.pathname === "/api/tenant-columns") {
      if (req.method !== "PUT") return new Response("Method not allowed", { status: 405 });
      if (!canEditTenants(user)) {
        console.warn(
          `[${new Date().toISOString()}] REJECTED column layout change by ${user.username} — not an editor`
        );
        return Response.json(
          { error: "Only Dan can change the column layout." },
          { status: 403, headers: { "Cache-Control": "no-store" } }
        );
      }

      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "expected a JSON body" }, { status: 400 });
      }

      const known = new Set(TENANT_COLUMNS.map((c) => c.field));
      const submitted = body?.columns;
      if (!Array.isArray(submitted) || submitted.length !== known.size) {
        return Response.json(
          { error: `expected { columns: [{field, width}] } naming all ${known.size} columns` },
          { status: 400 }
        );
      }

      const columns: { field: string; width: number }[] = [];
      const seen = new Set<string>();
      for (const entry of submitted) {
        const field = String(entry?.field ?? "");
        if (!known.has(field)) return Response.json({ error: `unknown column: ${field}` }, { status: 400 });
        if (seen.has(field)) return Response.json({ error: `duplicate column: ${field}` }, { status: 400 });
        const width = Math.round(Number(entry?.width));
        if (!Number.isFinite(width) || width < MIN_COLUMN_WIDTH || width > MAX_COLUMN_WIDTH) {
          return Response.json(
            { error: `width for ${field} must be ${MIN_COLUMN_WIDTH}-${MAX_COLUMN_WIDTH} pixels` },
            { status: 400 }
          );
        }
        seen.add(field);
        columns.push({ field, width });
      }

      writeSetting.run(COLUMN_LAYOUT_KEY, JSON.stringify(columns), user.username);
      console.log(
        `[${new Date().toISOString()}] tenant columns set by ${user.username}: ` +
          columns.map((c) => `${c.field}:${c.width}`).join(" ")
      );
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/calendar") {
      if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });
      return new Response(
        await renderAgendaPage(renderNav("/calendar", user), NAV_CSS, url.searchParams.get("start") ?? undefined),
        { headers: HTML_HEADERS }
      );
    }
    if (url.pathname === "/plates") {
      if (req.method === "GET") {
        return new Response(renderPlatesPage(renderNav("/plates", user), NAV_CSS), {
          headers: HTML_HEADERS,
        });
      }
      if (req.method === "POST") {
        const form = await req.formData();
        const plate = String(form.get("plate") ?? "").trim();
        const state = String(form.get("state") ?? "").trim();
        if (!plate) return platesPage(user, "A plate number is needed.");
        if (!STATES.includes(state)) return platesPage(user, "Pick a state.");

        // At most two, and the extras are refused rather than silently dropped,
        // so nobody believes a photo was kept when it wasn't.
        // The allowed list earns its keep here: told whose car it is, nobody
        // logs the neighbour who is meant to be there. It is a refusal rather
        // than a silent drop, so the person knows why nothing appeared.
        const allowed = allowedFor(plate);
        if (allowed && form.get("anyway") !== "yes") {
          return platesPage(
            user,
            undefined,
            `${allowed.plate_typed} is on the allowed list — ${allowed.label}. ` +
              `Not logged. Remove it from the allowed cars below if that has changed.`
          );
        }

        const files = form.getAll("photos").filter((f): f is File => f instanceof File && f.size > 0);
        if (files.length > MAX_PHOTOS) {
          return platesPage(user, `Up to ${MAX_PHOTOS} photos — you attached ${files.length}.`);
        }
        const saved = await savePhotos(files);
        if (saved.error) return platesPage(user, saved.error);
        const photos = saved.ids!;

        const year = String(form.get("year") ?? "").trim();
        if (year && !/^\d{4}$/.test(year)) return platesPage(user, "A year is four digits, or blank.");

        addReport({
          plate,
          state,
          location: String(form.get("location") ?? ""),
          notes: String(form.get("notes") ?? ""),
          color: String(form.get("color") ?? ""),
          year,
          make: String(form.get("make") ?? ""),
          model: String(form.get("model") ?? ""),
          photos,
          reportedBy: displayName(user),
        });
        console.log(
          `[${new Date().toISOString()}] plate logged by ${user.username}: ${plate} (${state})` +
            (photos.length ? `, ${photos.length} photo(s)` : "")
        );
        // Redirect after post, so a refresh doesn't log the same car twice.
        return new Response(null, { status: 303, headers: { Location: "/plates" } });
      }
      return new Response("Method not allowed", { status: 405 });
    }
    if (url.pathname === "/plates/allowed") {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      const form = await req.formData();
      const plate = String(form.get("plate") ?? "").trim();
      const state = String(form.get("state") ?? "").trim();
      const label = String(form.get("label") ?? "").trim();
      if (!plate) return platesPage(user, "A plate number is needed.");
      if (!STATES.includes(state)) return platesPage(user, "Pick a state.");
      if (!label) return platesPage(user, "Say whose car it is — that is the point of the list.");
      const already = allowedFor(plate);
      if (already) {
        return platesPage(user, undefined, `${already.plate_typed} is already allowed — ${already.label}.`);
      }
      allowCar(plate, state, label, displayName(user));
      console.log(
        `[${new Date().toISOString()}] plate allowed by ${user.username}: ${plate} (${state}) — ${label}`
      );
      return new Response(null, { status: 303, headers: { Location: "/plates" } });
    }
    const allowedRemove = url.pathname.match(/^\/plates\/allowed\/(\d+)\/remove$/);
    if (allowedRemove) {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      disallowCar(Number(allowedRemove[1]), user.username);
      return new Response(null, { status: 303, headers: { Location: "/plates" } });
    }
    if (url.pathname.startsWith("/plates/photo/")) {
      return await servePlatePhoto(url.pathname.slice("/plates/photo/".length));
    }
    const plateDelete = url.pathname.match(/^\/plates\/(\d+)\/delete$/);
    if (plateDelete) {
      if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
      deleteReport(Number(plateDelete[1]), user.username);
      return new Response(null, { status: 303, headers: { Location: "/plates" } });
    }
    if (url.pathname === "/api/sheets") {
      if (req.method === "GET") {
        return Response.json(loadSheets(), { headers: { "Cache-Control": "no-store, private" } });
      }
      if (req.method === "PUT") {
        const body = (await req.json()) as { sheets?: any[] };
        if (!Array.isArray(body?.sheets) || !body.sheets.every(validSheet)) {
          return Response.json(
            { error: "expected { sheets: [{id, name, columns, rows, rev}] }" },
            { status: 400 }
          );
        }
        // The rows as stored right now, read before the save overwrites them:
        // this is the only chance to see which tours are new in this request.
        const toursBefore = body.sheets.some((s: any) => s.id === TOURS_SHEET_ID)
          ? (db.query("SELECT rows FROM sheets WHERE id = ?").get(TOURS_SHEET_ID) as
              | { rows: string }
              | undefined)
          : undefined;

        const result = saveSheets(body.sheets, user.username);
        if (result.stale.length) {
          // Somebody else has saved since this page loaded. Nothing is written;
          // the page is handed the current content so it can merge and retry.
          console.log(
            `[${new Date().toISOString()}] sheets save by ${user.username} refused as stale: ` +
              result.stale.join(", ")
          );
          return Response.json(
            { error: "stale", stale: result.stale, ...loadSheets() },
            { status: 409, headers: { "Cache-Control": "no-store, private" } }
          );
        }
        console.log(
          `[${new Date().toISOString()}] sheets saved by ${user.username}: ` +
            body.sheets.map((s) => `${s.id}@${result.revs![s.id]} (${s.rows.length} rows)`).join(", ")
        );
        // Only after the save has committed: a tour that is safely on the
        // sheet but missing a calendar invite is a nuisance, a save refused
        // because Google was down would be a lost tour.
        queueTourEvents(body.sheets, toursBefore, user.username);
        return Response.json({ ok: true, savedAt: new Date().toISOString(), revs: result.revs });
      }
      return new Response("Method not allowed", { status: 405 });
    }
    return new Response("Not found", { status: 404 });
  },
});

startCalendarWorker();

console.log(`Listening on http://${server.hostname}:${server.port}`);
console.log(`Sign-in required — ${userCount} account${userCount === 1 ? "" : "s"} configured.`);
console.log(
  trustedOrigins.length
    ? `Trusted origins: ${trustedOrigins.join(", ")}`
    : "Trusted origins: none (same-host requests only — set TRUSTED_ORIGINS if behind a proxy)"
);
if (server.hostname === "0.0.0.0") {
  console.warn(
    "WARNING: bound to all interfaces over plain HTTP. Passwords and session\n" +
      "cookies are readable by anyone on the network. Put TLS in front of this."
  );
}
