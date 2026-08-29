#!/usr/bin/env bun
/**
 * The driveway plate log, from the command line.
 *
 *   bun run plates list                       # every report, repeats marked
 *   bun run plates repeats                    # only the plates seen more than once
 *   bun run plates defaults                   # what the form starts filled in with
 *   bun run plates defaults --state WA --location "12 Example Ave NE" --notes "Blocking garage"
 */

import { listReports, plateDefaults, setPlateDefaults, STATES } from "./plates";

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
    const rows = listReports().filter((r) => (cmd === "repeats" ? r.timesSeen > 1 : true));
    if (!rows.length) {
      console.log(cmd === "repeats" ? "No plate has been logged twice." : "Nothing logged yet.");
      break;
    }
    for (const r of rows) {
      const mark = r.occurrence > 1 ? `REPEAT ${r.occurrence}/${r.timesSeen}` : "";
      console.log(
        `${r.reported_on}  ${r.plate_typed.padEnd(10)} ${r.state.padEnd(8)} ${mark.padEnd(14)} ` +
          `${r.location ?? ""}${r.notes ? ` — ${r.notes}` : ""}`
      );
    }
    const plates = new Set(rows.filter((r) => r.timesSeen > 1).map((r) => r.plate));
    console.log(
      `\n${rows.length} report${rows.length === 1 ? "" : "s"}` +
        (plates.size ? `, ${plates.size} plate${plates.size === 1 ? "" : "s"} seen more than once` : "")
    );
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
      ].join("\n")
    );
    process.exit(cmd ? 1 : 0);
  }
}
