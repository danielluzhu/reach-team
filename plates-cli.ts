#!/usr/bin/env bun
/**
 * The driveway plate log, from the command line.
 *
 *   bun run plates list                       # every report, repeats marked
 *   bun run plates repeats                    # only the plates seen more than once
 *   bun run plates defaults                   # what the form starts filled in with
 *   bun run plates defaults --state WA --location "12 Example Ave NE" --notes "Blocking garage"
 *   bun run plates allowed                    # cars that belong here
 *   bun run plates allow <plate> <state> <whose car>
 *   bun run plates disallow <plate>
 */

import {
  allowCar,
  describeCar,
  allowedFor,
  disallowCar,
  listAllowed,
  listReports,
  plateDefaults,
  setPlateDefaults,
  STATES,
} from "./plates";

const [cmd, ...args] = process.argv.slice(2);

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** `--state WA --notes "two words"` → { state: "WA", notes: "two words" }. */
function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) die(`--${key} needs a value`);
    out[key] = value;
    i++;
  }
  return out;
}

switch (cmd) {
  case "list":
  case "repeats": {
    // An allowed car is never a repeat offender, the same as on the page.
    const rows = listReports().filter((r) =>
      cmd === "repeats" ? !r.allowed && r.timesSeen > 1 : true
    );
    if (!rows.length) {
      console.log(cmd === "repeats" ? "No plate has been logged twice." : "Nothing logged yet.");
      break;
    }
    for (const r of rows) {
      const mark = r.allowed
        ? `ALLOWED ${r.allowed.label}`
        : r.occurrence > 1
          ? `REPEAT ${r.occurrence}/${r.timesSeen}`
          : "";
      console.log(
        `${r.reported_on}  ${r.plate_typed.padEnd(10)} ${r.state.padEnd(4)} ` +
          `${describeCar(r).padEnd(22)} ${mark.padEnd(24)} ` +
          `${r.location ?? ""}${r.notes ? ` — ${r.notes}` : ""}`
      );
    }
    const plates = new Set(
      rows.filter((r) => !r.allowed && r.timesSeen > 1).map((r) => r.plate)
    );
    console.log(
      `\n${rows.length} report${rows.length === 1 ? "" : "s"}` +
        (plates.size ? `, ${plates.size} plate${plates.size === 1 ? "" : "s"} seen more than once` : "")
    );
    break;
  }

  case "allowed": {
    const cars = listAllowed();
    if (!cars.length) {
      console.log("No allowed cars. Every plate logged counts as a violation.");
      break;
    }
    for (const a of cars) {
      console.log(`  ${a.plate_typed.padEnd(10)} ${a.state.padEnd(8)} ${a.label}   (added by ${a.added_by})`);
    }
    break;
  }

  case "allow": {
    const [plate, state, ...rest] = args;
    const label = rest.join(" ");
    if (!plate || !state || !label) die('usage: plates allow <plate> <state> <whose car>');
    if (!STATES.includes(state)) die(`${state} is not a state on the form`);
    const already = allowedFor(plate);
    if (already) die(`${already.plate_typed} is already allowed — ${already.label}`);
    const car = allowCar(plate, state, label, "cli");
    console.log(`${car.plate_typed} (${car.state}) is allowed — ${car.label}`);
    break;
  }

  case "disallow": {
    const [plate] = args;
    if (!plate) die("usage: plates disallow <plate>");
    const car = allowedFor(plate);
    if (!car) die(`${plate} is not on the allowed list`);
    disallowCar(car.id, "cli");
    console.log(`${car.plate_typed} is no longer allowed — it will count as a violation from now on`);
    break;
  }

  case "defaults": {
    const set = flags(args);
    if (set.state && !STATES.includes(set.state)) die(`${set.state} is not a state on the form`);
    const current = Object.keys(set).length ? setPlateDefaults(set, "cli") : plateDefaults();
    console.log(`state:    ${current.state}`);
    console.log(`location: ${current.location || "(blank)"}`);
    console.log(`notes:    ${current.notes || "(blank)"}`);
    break;
  }

  default: {
    console.log(
      [
        "bun run plates list                      every report, repeats marked",
        "bun run plates repeats                   only plates seen more than once",
        "bun run plates defaults                  what the form starts filled in with",
        'bun run plates defaults --state WA --location "…" --notes "…"',
        "bun run plates allowed                   cars that belong here",
        "bun run plates allow <plate> <state> <whose car>",
        "bun run plates disallow <plate>",
      ].join("\n")
    );
    process.exit(cmd ? 1 : 0);
  }
}
