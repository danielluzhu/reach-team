#!/usr/bin/env bun
/**
 * Account management. There is no signup page — you create accounts here.
 *
 *   bun run users add <username> [--name "Full Name"]
 *   bun run users list
 *   bun run users passwd <username>
 *   bun run users remove <username>
 *   bun run users logout <username>     # end their sessions, keep the account
 */

import { db } from "./db";
import {
  hashPassword,
  destroyAllSessions,
  approveUser,
  createInvite,
  MIN_PASSWORD_LENGTH,
  USERNAME_RE,
} from "./auth";

const BASE_URL = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Reads a password without echoing it. Falls back to a plain line when piped. */
async function readSecret(label: string): Promise<string> {
  process.stdout.write(label);
  const stdin = process.stdin;

  if (!stdin.isTTY) {
    for await (const line of console) {
      process.stdout.write("\n");
      return line;
    }
    return "";
  }

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise<string>((resolve) => {
    let buf = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return (cleanup(), resolve(buf));
        if (ch === "\u0003") return (cleanup(), process.exit(130)); // Ctrl-C
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function promptNewPassword(): Promise<string> {
  const password = await readSecret("New password: ");
  if (password.length < MIN_PASSWORD_LENGTH) {
    die(`password must be at least ${MIN_PASSWORD_LENGTH} characters (got ${password.length})`);
  }
  const again = await readSecret("Confirm password: ");
  if (password !== again) die("passwords did not match");
  return password;
}

function findUser(username: string): { id: number; username: string } {
  const row = db.query("SELECT id, username FROM users WHERE username = ?").get(username) as
    | { id: number; username: string }
    | undefined;
  if (!row) die(`no such user: ${username}`);
  return row;
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "add": {
    const username = args[0];
    if (!username || username.startsWith("-")) die("usage: bun run users add <username> [--name \"Full Name\"]");
    if (!USERNAME_RE.test(username)) {
      die("username must be 2-32 chars, letters/numbers/dot/underscore/hyphen only");
    }

    const nameFlag = args.indexOf("--name");
    const displayName = nameFlag !== -1 ? args[nameFlag + 1] ?? null : null;

    const taken = db.query("SELECT 1 FROM users WHERE username = ?").get(username);
    if (taken) die(`username already taken: ${username}`);

    const password = await promptNewPassword();
    db.run("INSERT INTO users (username, display_name, password_hash) VALUES (?, ?, ?)", [
      username,
      displayName,
      await hashPassword(password),
    ]);
    console.log(`created user "${username}"${displayName ? ` (${displayName})` : ""}`);
    break;
  }

  case "approve":
  case "invite": {
    const username = args[0];
    const withCode = command === "invite";
    if (!username || username.startsWith("-")) {
      die(`usage: bun run users ${command} <username> [--name "Full Name"]`);
    }
    if (!USERNAME_RE.test(username)) {
      die("username must be 2-32 chars, letters/numbers/dot/underscore/hyphen only");
    }
    if (db.query("SELECT 1 FROM users WHERE username = ?").get(username)) {
      die(`"${username}" already has an account — use "passwd" to reset it`);
    }

    const nameFlag = args.indexOf("--name");
    const displayName = nameFlag !== -1 ? args[nameFlag + 1] ?? null : null;
    const who = `"${username}"${displayName ? ` (${displayName})` : ""}`;

    if (withCode) {
      const code = createInvite(username, displayName);
      const link = `${BASE_URL}/register?u=${encodeURIComponent(username)}&code=${encodeURIComponent(code)}`;
      console.log(`invite for ${who} — send them this link:\n\n  ${link}\n`);
      console.log("The code works once. Re-run this command to issue a fresh one.");
    } else {
      approveUser(username, displayName);
      console.log(`approved ${who} for sign-up.`);
      console.log(`They can sign up at ${BASE_URL}/register with that username — no code needed.`);
    }
    break;
  }

  case "approved": {
    const rows = db
      .query("SELECT username, display_name, code_hash, used_at FROM approved_users ORDER BY username")
      .all() as any[];
    if (rows.length === 0) {
      console.log("Nobody is approved yet. Add someone with: bun run users approve <username>");
      break;
    }
    console.log("username         name                 status         sign-up");
    console.log("-".repeat(64));
    for (const r of rows) {
      const status = r.used_at ? `claimed ${new Date(r.used_at).toISOString().slice(0, 10)}` : "pending";
      console.log(
        `${r.username.padEnd(16)} ${(r.display_name ?? "—").padEnd(20)} ${status.padEnd(14)} ` +
          `${r.code_hash ? "needs code" : "open"}`
      );
    }
    break;
  }

  case "unapprove":
  case "uninvite": {
    const username = args[0] ?? die(`usage: bun run users ${command} <username>`);
    const existing = db.query("SELECT 1 FROM approved_users WHERE username = ?").get(username);
    if (!existing) die(`not on the approved list: ${username}`);
    db.run("DELETE FROM approved_users WHERE username = ?", [username]);
    console.log(`removed "${username}" from the approved list.`);
    if (db.query("SELECT 1 FROM users WHERE username = ?").get(username)) {
      console.log(`Note: they already have an account. Use "remove ${username}" to revoke access.`);
    }
    break;
  }

  case "list": {
    const rows = db
      .query(
        `SELECT u.username, u.display_name, u.created_at, u.last_login_at,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active
           FROM users u ORDER BY u.username`
      )
      .all(Date.now()) as any[];

    if (rows.length === 0) {
      console.log("No users yet. Create one with: bun run users add <username>");
      break;
    }
    console.log("username         name                 last login           sessions");
    console.log("-".repeat(72));
    for (const r of rows) {
      console.log(
        `${r.username.padEnd(16)} ${(r.display_name ?? "—").padEnd(20)} ` +
          `${(r.last_login_at ?? "never").padEnd(20)} ${r.active}`
      );
    }
    break;
  }

  case "passwd": {
    const user = findUser(args[0] ?? die("usage: bun run users passwd <username>"));
    const password = await promptNewPassword();
    db.run("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(password), user.id]);
    // A password change should boot anyone using the old one.
    destroyAllSessions(user.id);
    console.log(`password updated for "${user.username}"; existing sessions signed out`);
    break;
  }

  case "remove": {
    const user = findUser(args[0] ?? die("usage: bun run users remove <username>"));
    db.run("DELETE FROM users WHERE id = ?", [user.id]); // sessions cascade
    console.log(`removed "${user.username}" and signed out their sessions`);
    break;
  }

  case "logout": {
    const user = findUser(args[0] ?? die("usage: bun run users logout <username>"));
    destroyAllSessions(user.id);
    console.log(`signed out all sessions for "${user.username}"`);
    break;
  }

  default:
    console.log(
      `Account management for the tenant CRM.\n\n` +
        `  bun run users approve <username> [--name "Full Name"]  let them sign up themselves\n` +
        `  bun run users invite <username> [--name "Full Name"]   same, but require a one-time code\n` +
        `  bun run users approved                                 who may sign up, and who has\n` +
        `  bun run users unapprove <username>                     take them off the list\n\n` +
        `  bun run users add <username> [--name "Full Name"]      create an account directly\n` +
        `  bun run users list\n` +
        `  bun run users passwd <username>\n` +
        `  bun run users remove <username>\n` +
        `  bun run users logout <username>\n`
    );
    process.exit(command ? 1 : 0);
}
