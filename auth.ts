/**
 * Username/password authentication with server-side sessions.
 *
 * Passwords are hashed with argon2id (Bun's built-in default). Sessions live in
 * SQLite rather than in a signed cookie, so signing someone out — or removing
 * them from the team — takes effect on their very next request instead of
 * whenever a token happens to expire.
 */

import { db } from "./db";

const COOKIE = "crm_session";
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const SESSION_RENEW_MS = 24 * 60 * 60 * 1000; // slide the expiry if older than a day

export const MIN_PASSWORD_LENGTH = 8;
export const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;

export type User = { id: number; username: string; display_name: string | null };

/** What the nav bar shows for a signed-in user. */
export function displayName(user: User): string {
  return user.display_name || user.username;
}

/**
 * Who may change tenant rows. Everyone signed in can read the Tenants & Access
 * page; only this account can edit it. Usernames are stored COLLATE NOCASE, so
 * the comparison is case-insensitive too — "Dan" and "dan" are one account.
 */
const TENANT_EDITOR = "dan";

export function canEditTenants(user: User): boolean {
  return user.username.toLowerCase() === TENANT_EDITOR;
}

// ---------------------------------------------------------------- passwords

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/**
 * A hash of a throwaway password, used to keep the "no such user" path as slow
 * as the "wrong password" path — otherwise response timing tells an attacker
 * which usernames are real.
 */
const DUMMY_HASH = await hashPassword("not-a-real-password-placeholder");

// ----------------------------------------------------------------- sessions

function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

const insertSession = db.prepare(
  `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent)
   VALUES (?, ?, ?, ?, ?)`
);

export function createSession(userId: number, userAgent: string | null): string {
  const token = newToken();
  const now = Date.now();
  insertSession.run(sha256(token), userId, now, now + SESSION_TTL_MS, userAgent?.slice(0, 200) ?? null);
  db.run("DELETE FROM sessions WHERE expires_at < ?", [now]);
  return token;
}

export function destroySession(token: string): void {
  db.run("DELETE FROM sessions WHERE token_hash = ?", [sha256(token)]);
}

/** Sign a user out everywhere — used when a password changes. */
export function destroyAllSessions(userId: number): void {
  db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
}

const findSession = db.prepare(
  `SELECT s.expires_at, u.id, u.username, u.display_name
     FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?`
);

function userForToken(token: string): User | null {
  const row = findSession.get(sha256(token)) as
    | { expires_at: number; id: number; username: string; display_name: string | null }
    | undefined;
  if (!row) return null;

  const now = Date.now();
  if (row.expires_at <= now) {
    db.run("DELETE FROM sessions WHERE token_hash = ?", [sha256(token)]);
    return null;
  }

  // Sliding expiry: active users stay signed in, idle ones eventually don't.
  if (row.expires_at - now < SESSION_TTL_MS - SESSION_RENEW_MS) {
    db.run("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", [now + SESSION_TTL_MS, sha256(token)]);
  }

  return { id: row.id, username: row.username, display_name: row.display_name };
}

// ------------------------------------------------------------------ cookies

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * `Secure` can't be set unconditionally — it would break plain-HTTP access on
 * localhost — so it follows the actual scheme, including behind a TLS proxy.
 */
function isSecureRequest(req: Request): boolean {
  if (req.headers.get("X-Forwarded-Proto")?.split(",")[0].trim() === "https") return true;
  return new URL(req.url).protocol === "https:";
}

function sessionCookie(req: Request, token: string, maxAgeSec: number): string {
  const flags = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly", // JavaScript can't read it, so an XSS bug can't exfiltrate the session
    "SameSite=Lax", // another site can't ride along on a logged-in browser
    `Max-Age=${maxAgeSec}`,
  ];
  if (isSecureRequest(req)) flags.push("Secure");
  return flags.join("; ");
}

// ------------------------------------------------------------- login limiter

/**
 * Throttles password guessing, keyed by IP *and* by username, so an attacker
 * can't spread guesses across addresses to hammer one account. In memory, which
 * means a restart clears it — fine for a small team app.
 */
const LOCKOUT_MS = 15 * 60 * 1000;
/** Per account: tight, because guesses against one name are what we fear. */
const MAX_ATTEMPTS_USER = 8;
/**
 * Per address: looser, because a whole team can share one office IP and one
 * person fumbling their password must not lock out everyone else. It still caps
 * someone spraying guesses across many usernames from one place.
 */
const MAX_ATTEMPTS_IP = 40;

const attempts = new Map<string, { count: number; first: number }>();

function throttleKeys(ip: string, username: string): Array<{ key: string; max: number }> {
  return [
    { key: `ip:${ip}`, max: MAX_ATTEMPTS_IP },
    { key: `user:${username.toLowerCase()}`, max: MAX_ATTEMPTS_USER },
  ];
}

function isLockedOut(ip: string, username: string): boolean {
  const now = Date.now();
  return throttleKeys(ip, username).some(({ key, max }) => {
    const record = attempts.get(key);
    if (!record) return false;
    if (now - record.first > LOCKOUT_MS) {
      attempts.delete(key);
      return false;
    }
    return record.count >= max;
  });
}

function recordFailure(ip: string, username: string): void {
  const now = Date.now();
  for (const { key } of throttleKeys(ip, username)) {
    const record = attempts.get(key);
    if (!record || now - record.first > LOCKOUT_MS) attempts.set(key, { count: 1, first: now });
    else record.count++;
  }
}

function clearFailures(ip: string, username: string): void {
  for (const { key } of throttleKeys(ip, username)) attempts.delete(key);
}

// --------------------------------------------------------------------- pages

const PAGE_CSS = `
  * { box-sizing: border-box; }
  body { font-family: system-ui, sans-serif; background: #f3f4f6; color: #1a1a1a;
    display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
  .card { background: #fff; padding: 2rem; border-radius: 10px; box-shadow: 0 1px 3px rgba(0,0,0,.12);
    width: 100%; max-width: 22rem; }
  h1 { font-size: 1.15rem; margin: 0 0 1.25rem; }
  label { display: block; font-size: .8rem; font-weight: 600; color: #444; margin-bottom: .3rem; }
  input { width: 100%; padding: .55rem .7rem; margin-bottom: 1rem; border: 1px solid #d1d5db;
    border-radius: 6px; font-size: .95rem; font-family: inherit; }
  input:focus { outline: 2px solid #60a5fa; outline-offset: -1px; border-color: transparent; }
  button { width: 100%; padding: .6rem; background: #1f2937; color: #fff; border: 0;
    border-radius: 6px; font-size: .9rem; font-weight: 600; cursor: pointer; font-family: inherit; }
  button:hover { background: #374151; }
  .error { background: #fee2e2; color: #991b1b; padding: .6rem .75rem; border-radius: 6px;
    font-size: .85rem; margin-bottom: 1rem; }
  .hint { font-size: .8rem; color: #666; margin: -.6rem 0 1rem; }
  .alt { margin: 1rem 0 0; text-align: center; font-size: .85rem; color: #555; }
  .alt a { color: #1f2937; }`;

/**
 * The tab icon, for every page that has a <head>. Served by the `/favicon.svg`
 * route in server.ts from `public/favicon.svg`; the two doc pages and
 * `public/sheets.html` carry the same line, written out where they build their
 * own <head>.
 */
export const FAVICON_LINK = `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />`;

export function renderLogin(error?: string, next = "/"): string {
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in</title>${FAVICON_LINK}<style>${PAGE_CSS}</style></head>
<body>
  <form class="card" method="POST" action="/login">
    <h1>Tenant CRM</h1>
    ${error ? `<div class="error">${error}</div>` : ""}
    <input type="hidden" name="next" value="${safeNext.replace(/"/g, "&quot;")}" />
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" autofocus required />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required />
    <button type="submit">Sign in</button>
    <p class="alt">Don't have an account yet? <a href="/register">Sign up</a></p>
  </form>
</body></html>`;
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store, private",
  "X-Frame-Options": "DENY",
} as const;

// ------------------------------------------------------------------ handlers

const findUser = db.prepare(`SELECT id, username, display_name, password_hash FROM users WHERE username = ?`);
const countUsers = db.prepare(`SELECT COUNT(*) AS n FROM users`);

/** How many accounts exist. Zero means the app still needs its first user. */
export function accountCount(): number {
  return (countUsers.get() as { n: number }).n;
}

/**
 * First-run setup is only offered to a request coming from this machine, so
 * that an app briefly reachable on a network can't be claimed by a stranger.
 */
export function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

// ---------------------------------------------------------- approved sign-ups

/** Approves a username for open sign-up: no code, they just pick a password. */
export function approveUser(username: string, displayNameInput: string | null): void {
  db.run(
    `INSERT INTO approved_users (username, display_name, code_hash, created_at, used_at)
     VALUES (?, ?, NULL, ?, NULL)
     ON CONFLICT(username) DO UPDATE SET
       display_name = excluded.display_name, code_hash = NULL,
       created_at = excluded.created_at, used_at = NULL`,
    [username, displayNameInput, Date.now()]
  );
}

/** Approves a username but requires the returned one-time code to claim it. */
export function createInvite(username: string, displayNameInput: string | null): string {
  const code = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  db.run(
    `INSERT INTO approved_users (username, display_name, code_hash, created_at, used_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(username) DO UPDATE SET
       display_name = excluded.display_name, code_hash = excluded.code_hash,
       created_at = excluded.created_at, used_at = NULL`,
    [username, displayNameInput, sha256(code), Date.now()]
  );
  return code;
}

const findApproved = db.prepare(
  `SELECT username, display_name, code_hash FROM approved_users WHERE username = ? AND used_at IS NULL`
);

const attr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function renderRegister(
  error?: string,
  values: { username?: string; displayName?: string; code?: string } = {},
  showCode = false
): string {
  const { username = "", displayName = "", code = "" } = values;
  return `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign up</title>${FAVICON_LINK}<style>${PAGE_CSS}</style></head>
<body>
  <form class="card" method="POST" action="/register">
    <h1>Create your account</h1>
    ${error ? `<div class="error">${error}</div>` : ""}
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" value="${attr(username)}" autofocus required />
    <label for="display_name">Display name <span style="font-weight:400">(optional)</span></label>
    <input id="display_name" name="display_name" autocomplete="name" value="${attr(displayName)}" />
    ${
      showCode || code
        ? `<label for="code">Invite code</label>
    <input id="code" name="code" value="${attr(code)}" required />`
        : ""
    }
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required />
    <p class="hint">At least ${MIN_PASSWORD_LENGTH} characters.</p>
    <label for="confirm">Confirm password</label>
    <input id="confirm" name="confirm" type="password" autocomplete="new-password" required />
    <button type="submit">Create account &amp; sign in</button>
    <p class="alt">Already have an account? <a href="/login">Sign in</a></p>
  </form>
</body></html>`;
}

export async function handleRegister(req: Request, ip: string): Promise<Response> {
  const form = await req.formData();
  const username = String(form.get("username") ?? "").trim();
  const displayNameInput = String(form.get("display_name") ?? "").trim();
  const code = String(form.get("code") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");
  const values = { username, displayName: displayNameInput, code };

  const fail = (message: string, status = 400, showCode = false) =>
    new Response(renderRegister(message, values, showCode), { status, headers: PAGE_HEADERS });

  if (isLockedOut(ip, username)) {
    return new Response(renderRegister("Too many attempts. Wait 15 minutes and try again.", values), {
      status: 429,
      headers: PAGE_HEADERS,
    });
  }

  if (!USERNAME_RE.test(username)) {
    return fail("Username must be 2-32 characters: letters, numbers, dot, underscore or hyphen.");
  }

  const approved = findApproved.get(username) as
    | { username: string; display_name: string | null; code_hash: string | null }
    | undefined;

  if (!approved) {
    recordFailure(ip, username);
    console.warn(`[${new Date().toISOString()}] sign-up attempt for unapproved "${username}" from ${ip}`);
    // Deliberately covers both "never approved" and "already claimed", so the
    // form can't be used to enumerate who is on the team.
    return fail("That username isn't approved for sign-up. Ask Dan to add you.", 403);
  }

  // Only some approvals carry a code; those that do must match.
  if (approved.code_hash !== null && approved.code_hash !== sha256(code)) {
    recordFailure(ip, username);
    console.warn(`[${new Date().toISOString()}] bad invite code for "${username}" from ${ip}`);
    return fail(
      code ? "That invite code isn't valid." : "This username needs the invite code Dan sent you.",
      403,
      true
    );
  }

  if (password.length < MIN_PASSWORD_LENGTH) return fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (password !== confirm) return fail("Passwords did not match.");

  if (findUser.get(approved.username)) return fail("That account already exists — sign in instead.", 409);

  const created = db.query(
    `INSERT INTO users (username, display_name, password_hash, last_login_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP) RETURNING id`
  ).get(
    approved.username,
    displayNameInput || approved.display_name,
    await hashPassword(password)
  ) as { id: number };

  db.run("UPDATE approved_users SET used_at = ? WHERE username = ?", [Date.now(), approved.username]);
  clearFailures(ip, username);
  console.log(`[${new Date().toISOString()}] ${approved.username} signed up from ${ip}`);

  const token = createSession(created.id, req.headers.get("User-Agent"));
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": sessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000)),
      "Cache-Control": "no-store, private",
    },
  });
}

export function renderSetup(error?: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Set up your account</title>${FAVICON_LINK}<style>${PAGE_CSS}</style></head>
<body>
  <form class="card" method="POST" action="/setup">
    <h1>Create the first account</h1>
    <p class="hint">Nobody can sign in yet. This page is only available from this
      computer, and disappears once an account exists.</p>
    ${error ? `<div class="error">${error}</div>` : ""}
    <label for="username">Username</label>
    <input id="username" name="username" autocomplete="username" autofocus required />
    <label for="display_name">Display name <span style="font-weight:400">(optional)</span></label>
    <input id="display_name" name="display_name" autocomplete="name" />
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="new-password" required />
    <p class="hint">At least ${MIN_PASSWORD_LENGTH} characters.</p>
    <label for="confirm">Confirm password</label>
    <input id="confirm" name="confirm" type="password" autocomplete="new-password" required />
    <button type="submit">Create account &amp; sign in</button>
  </form>
</body></html>`;
}

export async function handleSetup(req: Request): Promise<Response> {
  const fail = (message: string, status = 400) =>
    new Response(renderSetup(message), { status, headers: PAGE_HEADERS });

  // Re-checked here, not just at the route, so two racing submissions can't
  // both create a "first" account.
  if (accountCount() > 0) {
    return new Response(null, { status: 303, headers: { Location: "/login", "Cache-Control": "no-store" } });
  }

  const form = await req.formData();
  const username = String(form.get("username") ?? "").trim();
  const displayNameInput = String(form.get("display_name") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  if (!USERNAME_RE.test(username)) {
    return fail("Username must be 2-32 characters: letters, numbers, dot, underscore or hyphen.");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password !== confirm) return fail("Passwords did not match.");

  const info = db.query(
    `INSERT INTO users (username, display_name, password_hash, last_login_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP) RETURNING id`
  ).get(username, displayNameInput || null, await hashPassword(password)) as { id: number };

  console.log(`[${new Date().toISOString()}] first account created: ${username}`);

  const token = createSession(info.id, req.headers.get("User-Agent"));
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": sessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000)),
      "Cache-Control": "no-store, private",
    },
  });
}

export async function handleLogin(req: Request, ip: string): Promise<Response> {
  const form = await req.formData();
  const username = String(form.get("username") ?? "").trim();
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "/");

  if (!username || !password) {
    return new Response(renderLogin("Enter a username and password.", next), { status: 400, headers: PAGE_HEADERS });
  }

  if (isLockedOut(ip, username)) {
    console.warn(`[${new Date().toISOString()}] login throttled for "${username}" from ${ip}`);
    return new Response(
      renderLogin("Too many failed attempts. Wait 15 minutes and try again.", next),
      { status: 429, headers: PAGE_HEADERS }
    );
  }

  const row = findUser.get(username) as
    | { id: number; username: string; display_name: string | null; password_hash: string }
    | undefined;

  // Always verify against *something*, so a missing user and a wrong password
  // take the same amount of time.
  const ok = await Bun.password.verify(password, row?.password_hash ?? DUMMY_HASH);

  if (!row || !ok) {
    recordFailure(ip, username);
    console.warn(`[${new Date().toISOString()}] failed login for "${username}" from ${ip}`);
    // Deliberately vague: don't reveal whether the username exists.
    return new Response(renderLogin("Incorrect username or password.", next), { status: 401, headers: PAGE_HEADERS });
  }

  clearFailures(ip, username);
  db.run("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?", [row.id]);

  const token = createSession(row.id, req.headers.get("User-Agent"));
  console.log(`[${new Date().toISOString()}] ${row.username} signed in from ${ip}`);

  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return new Response(null, {
    status: 303,
    headers: {
      Location: safeNext,
      "Set-Cookie": sessionCookie(req, token, Math.floor(SESSION_TTL_MS / 1000)),
      "Cache-Control": "no-store, private",
    },
  });
}

export function handleLogout(req: Request): Response {
  const token = readCookie(req, COOKIE);
  if (token) destroySession(token);
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/login",
      "Set-Cookie": sessionCookie(req, "", 0),
      "Cache-Control": "no-store, private",
    },
  });
}

/**
 * Origins allowed in addition to the request's own host. Needed behind a
 * reverse proxy that doesn't preserve Host: the browser sends the public
 * origin while the app sees the backend address, and the two never match.
 *
 *   TRUSTED_ORIGINS=https://crm.example.com,https://www.example.com
 *
 * Listed explicitly rather than read from X-Forwarded-Host, which any client
 * could set — that would hand back the CSRF hole this check exists to close.
 */
const TRUSTED_ORIGINS = new Set(
  (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        console.warn(`Ignoring unparseable TRUSTED_ORIGINS entry: ${value}`);
        return "";
      }
    })
    .filter(Boolean)
);

export const trustedOrigins = [...TRUSTED_ORIGINS];

/**
 * Blocks cross-site state-changing requests. SameSite=Lax already covers the
 * common cases; this closes the gap for anything that sends an Origin we don't
 * recognise.
 */
function originMismatch(req: Request): boolean {
  if (req.method === "GET" || req.method === "HEAD") return false;
  const origin = req.headers.get("Origin");
  if (!origin) return false; // non-browser clients (curl) send none
  try {
    const sent = new URL(origin);
    if (sent.host === new URL(req.url).host) return false;
    return !TRUSTED_ORIGINS.has(sent.origin);
  } catch {
    return true;
  }
}

/**
 * Gate a request: returns the signed-in user, or a Response to send instead.
 * Browsers get redirected to the login page; API callers get a 401 in JSON.
 */
export function authenticate(req: Request): User | Response {
  const url = new URL(req.url);
  const stamp = () => new Date().toISOString();

  if (originMismatch(req)) {
    console.warn(
      `[${stamp()}] REJECTED cross-origin ${req.method} ${url.pathname} — ` +
        `Origin: ${req.headers.get("Origin")} vs Host: ${url.host}. ` +
        `If that Origin is yours, add it to TRUSTED_ORIGINS (see README).`
    );
    return Response.json({ error: "cross-origin request rejected" }, { status: 403 });
  }

  const token = readCookie(req, COOKIE);
  const user = token ? userForToken(token) : null;
  if (user) return user;

  if (url.pathname.startsWith("/api/")) {
    // Says whether the browser sent no cookie at all, or one the database
    // doesn't recognise — a very different diagnosis.
    console.warn(
      `[${stamp()}] REJECTED unauthenticated ${req.method} ${url.pathname} — ` +
        `session cookie ${token ? "present but unknown/expired" : "ABSENT"}` +
        `${req.headers.get("Cookie") ? "" : " (no Cookie header at all)"}`
    );
    return Response.json({ error: "not authenticated" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const next = encodeURIComponent(url.pathname + url.search);
  return new Response(null, {
    status: 303,
    headers: { Location: `/login?next=${next}`, "Cache-Control": "no-store, private" },
  });
}

export { PAGE_HEADERS };
