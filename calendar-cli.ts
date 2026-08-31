#!/usr/bin/env bun
/**
 * The tour → calendar plumbing, from the command line.
 *
 *   bun run calendar status                       # config, and what's queued
 *   bun run calendar doctor                       # what the deployed script can do
 *   bun run calendar guides                       # list guide → email
 *   bun run calendar guides set <name> <email>    # a guide's address
 *   bun run calendar guides rm <name>
 *   bun run calendar properties                   # street line → full address
 *   bun run calendar properties set <street> <full address>
 *   bun run calendar properties rm <street>
 *   bun run calendar city [<name>]                # the city the properties are in
 *   bun run calendar queue [--all]                # recent events, failures first
 *   bun run calendar retry [<key>|--all]          # put failed rows back
 *   bun run calendar test                         # book a throwaway event now
 *   bun run calendar backfill <from> [<to>]       # queue tours already on the sheet
 *   bun run calendar poll                         # pull guest edits into the sheet
 *   bun run calendar refresh                      # re-send every event unchanged
 */

import { db } from "./db";
import {
  DEFAULT_MINUTES,
  STANDING_GUESTS,
  TOUR_TIMEZONE,
  calendarConfigured,
  checkDeployment,
  flushQueue,
  pollCalendarChanges,
  requeueSentEvents,
  guideEmails,
  propertyAddresses,
  propertyCity,
  setGuideEmails,
  setPropertyAddresses,
  setPropertyCity,
  tourEventFrom,
} from "./calendar";

const [cmd, ...args] = process.argv.slice(2);

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

const toursSheet = () =>
  db.query("SELECT columns, rows FROM sheets WHERE id = 'tours'").get() as
    | { columns: string; rows: string }
    | undefined;

switch (cmd) {
  case "status": {
    const on = calendarConfigured();
    console.log(`Webhook:   ${on ? process.env.CALENDAR_WEBHOOK_URL : "not configured"}`);
    console.log(`Secret:    ${process.env.CALENDAR_WEBHOOK_SECRET ? "set" : "MISSING"}`);
    console.log(`Timezone:  ${TOUR_TIMEZONE}   Default length: ${DEFAULT_MINUTES} min`);
    console.log(
      `Always invites: ${STANDING_GUESTS.length ? STANDING_GUESTS.join(", ") : "nobody (set CALENDAR_STANDING_GUESTS)"}`
    );
    const props = Object.keys(propertyAddresses());
    console.log(`Properties on file: ${props.length || "none"}${propertyCity() ? ` in ${propertyCity()}` : " (no city set)"}`);
    const guides = guideEmails();
    const names = Object.keys(guides);
    console.log(`Guides on file: ${names.length ? names.join(", ") : "none — office only"}`);
    const counts = db
      .query("SELECT state, COUNT(*) AS n FROM tour_events GROUP BY state")
      .all() as { state: string; n: number }[];
    console.log(
      `Queue: ${counts.length ? counts.map((c) => `${c.n} ${c.state}`).join(", ") : "empty"}`
    );
    if (!on) console.log("\nEvents are being queued but not sent. See google-apps-script/tour-calendar.gs");
    break;
  }

  case "doctor": {
    console.log("Asking the deployed Apps Script what it can do…\n");
    const checks = await checkDeployment();
    for (const c of checks) console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(22)} ${c.detail}`);
    const stale = checks.some((c) => !c.ok && c.detail.includes("older than this action"));
    const broken = checks.filter((c) => !c.ok);
    console.log("");
    if (!broken.length) console.log("Everything the CRM needs is live.");
    else if (stale) {
      console.log("The script in this repo is newer than what Google is serving.");
      console.log("Paste google-apps-script/tour-calendar.gs into the editor, then:");
      console.log("  Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy");
      console.log("The /exec URL does not change. Re-run this command afterwards.");
    }
    process.exit(broken.length ? 1 : 0);
  }

  case "guides": {
    const [sub, name, email] = args;
    const map = guideEmails();
    if (!sub || sub === "list") {
      const entries = Object.entries(map);
      if (!entries.length) console.log("No guide emails set. Only the office is invited.");
      else for (const [n, e] of entries) console.log(`  ${n.padEnd(12)} ${e}`);
      break;
    }
    if (sub === "set") {
      if (!name || !email?.includes("@")) die("usage: calendar guides set <name> <email>");
      map[name.toLowerCase()] = email;
      setGuideEmails(map, "cli");
      console.log(`${name} → ${email}`);
      break;
    }
    if (sub === "rm") {
      if (!name) die("usage: calendar guides rm <name>");
      delete map[name.toLowerCase()];
      setGuideEmails(map, "cli");
      console.log(`removed ${name}`);
      break;
    }
    die(`unknown: guides ${sub}`);
  }

  case "properties": {
    const [sub, street, ...rest] = args;
    const map = propertyAddresses();
    if (!sub || sub === "list") {
      const entries = Object.entries(map);
      if (!entries.length) {
        console.log("No properties set. Titles use whatever the sheet's Location says.");
      } else for (const [s, full] of entries) console.log(`  ${s.padEnd(24)} ${full}`);
      break;
    }
    if (sub === "set") {
      const full = rest.join(" ");
      if (!street || !full) die("usage: calendar properties set <street line> <full address>");
      map[street.toLowerCase()] = full;
      setPropertyAddresses(map, "cli");
      console.log(`${street} → ${full}`);
      break;
    }
    if (sub === "rm") {
      if (!street) die("usage: calendar properties rm <street line>");
      delete map[street.toLowerCase()];
      setPropertyAddresses(map, "cli");
      console.log(`removed ${street}`);
      break;
    }
    die(`unknown: properties ${sub}`);
  }

  case "city": {
    if (!args.length) {
      console.log(propertyCity() || "(not set — the street line is cut at the first comma)");
      break;
    }
    setPropertyCity(args.join(" "), "cli");
    console.log(`city set to ${args.join(" ")}`);
    break;
  }

  case "refresh": {
    if (!calendarConfigured()) die("CALENDAR_WEBHOOK_URL / CALENDAR_WEBHOOK_SECRET not set");
    const n = requeueSentEvents();
    if (!n) {
      console.log("No events to refresh.");
      break;
    }
    console.log(`Re-sending ${n} event(s) so the script's current settings apply to them…`);
    await flushQueue(n);
    const stuck = db.query("SELECT title, last_error FROM tour_events WHERE state != 'sent'").all() as any[];
    for (const s of stuck) console.log(`  still not sent: ${s.title} — ${s.last_error}`);
    console.log(stuck.length ? `${stuck.length} failed.` : "All refreshed.");
    break;
  }

  case "poll": {
    if (!calendarConfigured()) die("CALENDAR_WEBHOOK_URL / CALENDAR_WEBHOOK_SECRET not set");
    const changes = await pollCalendarChanges();
    if (!changes.length) {
      console.log("No calendar edits to pull in — the sheet and the calendar agree.");
      break;
    }
    for (const c of changes) {
      console.log(`  ${c.title}`);
      for (const [field, [was, now]] of Object.entries(c.fields)) {
        console.log(`      ${field}: ${was || "(blank)"} → ${now}`);
      }
    }
    console.log(`\n${changes.length} tour(s) updated from the calendar.`);
    break;
  }

  case "queue": {
    const all = args.includes("--all");
    const rows = db
      .query(
        `SELECT key, title, starts_at, state, attempts, last_error, event_id FROM tour_events
         ${all ? "" : "WHERE state != 'sent'"}
         ORDER BY CASE state WHEN 'failed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, starts_at DESC
         LIMIT 50`
      )
      .all() as any[];
    if (!rows.length) {
      console.log(all ? "Queue is empty." : "Nothing pending or failed.");
      break;
    }
    for (const r of rows) {
      console.log(
        `${r.state.padEnd(7)} ${String(r.starts_at).padEnd(20)} ${r.title}` +
          (r.attempts ? `  (${r.attempts} attempt${r.attempts === 1 ? "" : "s"})` : "")
      );
      if (r.last_error) console.log(`        ↳ ${r.last_error}`);
    }
    break;
  }

  case "retry": {
    const target = args[0];
    if (!target) die("usage: calendar retry <key>|--all");
    const res =
      target === "--all"
        ? db.run("UPDATE tour_events SET state='pending', attempts=0 WHERE state='failed'")
        : db.run("UPDATE tour_events SET state='pending', attempts=0 WHERE key=?", [target]);
    console.log(`${res.changes} row${res.changes === 1 ? "" : "s"} re-queued`);
    await flushQueue(50);
    break;
  }

  case "test": {
    if (!calendarConfigured()) die("CALENDAR_WEBHOOK_URL / CALENDAR_WEBHOOK_SECRET not set");
    const when = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const key = `selftest-${Date.now()}`;
    db.run(
      `INSERT INTO tour_events (key, title, starts_at, payload, payload_sig, added_by, created_at)
       VALUES (?, ?, ?, ?, 'selftest', 'cli', ?)`,
      [
        key,
        "CRM calendar self-test — safe to delete",
        `${when} 09:00:00`,
        JSON.stringify({
          title: "CRM calendar self-test — safe to delete",
          location: "",
          description: "Created by `bun run calendar test`. Delete this.",
          guests: [],
          start: `${when} 09:00:00`,
          end: `${when} 09:15:00`,
          timeZone: TOUR_TIMEZONE,
        }),
        new Date().toISOString(),
      ]
    );
    console.log(`Queued a test event for ${when} 09:00 with no guests. Posting…`);
    await flushQueue(1, key);
    const row = db.query("SELECT state, last_error FROM tour_events WHERE key=?").get(key) as any;
    console.log(row.state === "sent" ? "Created — check the calendar." : `Failed: ${row.last_error}`);
    break;
  }

  /**
   * Tours already on the sheet were never "added" while this was running, so
   * nothing queued them. This books a date range on demand — the way to get
   * historic tours onto the calendar without re-typing them.
   */
  case "backfill": {
    const [from, to = "9999-12-31"] = args;
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) die("usage: calendar backfill <YYYY-MM-DD> [<YYYY-MM-DD>]");
    const sheet = toursSheet();
    if (!sheet) die("no tours sheet");
    const columns = JSON.parse(sheet.columns);
    const rows = JSON.parse(sheet.rows) as any[][];
    const dateCol = columns.findIndex((c: any) => c.name?.toLowerCase() === "date");

    const insert = db.prepare(
      `INSERT OR IGNORE INTO tour_events
         (key, title, starts_at, payload, payload_sig, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'backfill', ?)`
    );
    let queued = 0;
    for (const row of rows) {
      const date = String(row[dateCol] ?? "");
      if (date < from || date > to) continue;
      const e = tourEventFrom(row, columns);
      if (!e) continue;
      const payload = JSON.stringify(e);
      const res = insert.run(
        e.key, e.title, e.start ?? e.allDayOn ?? "", payload, "backfill", new Date().toISOString()
      );
      if (res.changes) {
        queued++;
        console.log(`  ${(e.start ?? `${e.allDayOn} (all day)`).padEnd(20)} ${e.title}`);
        if (e.unknownGuides.length) console.log(`        ↳ no email for ${e.unknownGuides.join(", ")}`);
      }
    }
    console.log(`\n${queued} queued.`);
    if (queued && calendarConfigured()) {
      console.log("Posting…");
      await flushQueue(queued);
    } else if (queued) {
      console.log("Not configured, so nothing was sent — they will go out once the webhook is set.");
    }
    break;
  }

  default: {
    const usage = [
      "bun run calendar status                       config, and what's queued",
      "bun run calendar guides                       list guide → email",
      "bun run calendar guides set <name> <email>    set a guide's address",
      "bun run calendar guides rm <name>             forget one",
      "bun run calendar properties                   street line → full address",
      "bun run calendar properties set <street> <address>",
      "bun run calendar properties rm <street>",
      "bun run calendar city [<name>]                the city the properties are in",
      "bun run calendar queue [--all]                recent events, failures first",
      "bun run calendar retry <key>|--all            put failed rows back",
      "bun run calendar test                         book a throwaway event now",
      "bun run calendar backfill <from> [<to>]       queue tours already on the sheet",
      "bun run calendar poll                         pull guest edits into the sheet",
      "bun run calendar refresh                      re-send every event unchanged",
    ];
    console.log(usage.join("\n"));
    process.exit(cmd ? 1 : 0);
  }
}
