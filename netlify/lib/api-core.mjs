// Account + cloud-save API for Cookie Clicker.
//
// Storage is passed in so the same code runs on Netlify (Blobs) and in the
// local dev server (in memory). Each store needs:
//   get(key) -> object | null, set(key, object), del(key), keys() -> string[]
import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD = 4;
const MAX_PASSWORD = 100;
const MAX_SAVE_BYTES = 200_000;
const MAX_SESSIONS_PER_USER = 20;   // oldest device gets logged out past this
const MAX_FAILED_LOGINS = 10;
const LOCK_MS = 5 * 60 * 1000;

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});
const fail = (status, error) => json(status, { error });

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const userKey = (name) => String(name).toLowerCase();
const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

async function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = (await scrypt(password, salt, 64)).toString("hex");
  return { salt, hash };
}

async function passwordMatches(password, user) {
  const { hash } = await hashPassword(password, user.salt);
  return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(user.hash, "hex"));
}

function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (pw.length > MAX_PASSWORD) return `Password must be at most ${MAX_PASSWORD} characters.`;
  return null;
}

const publicUser = (u) => ({ username: u.username, isAdmin: !!u.isAdmin });

export function createApi({ users, sessions, saves }) {
  async function startSession(user) {
    const token = randomBytes(32).toString("hex");
    const key = sha256(token); // only the hash is stored, so a leaked store can't be used to log in
    await sessions.set(key, { username: userKey(user.username), createdAt: Date.now() });
    const list = [...(user.sessions || []), key];
    for (const old of list.splice(0, Math.max(0, list.length - MAX_SESSIONS_PER_USER))) await sessions.del(old);
    user.sessions = list;
    await users.set(userKey(user.username), user);
    return token;
  }

  async function endSessions(user, keep = null) {
    for (const key of user.sessions || []) if (key !== keep) await sessions.del(key);
    user.sessions = keep ? [keep] : [];
  }

  async function authenticate(req) {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.get("authorization") || "");
    if (!m) return null;
    const sessionKey = sha256(m[1]);
    const session = await sessions.get(sessionKey);
    if (!session) return null;
    const user = await users.get(session.username);
    return user ? { user, sessionKey } : null;
  }

  const actions = {
    async register(body) {
      const { username, password } = body;
      if (typeof username !== "string" || !USERNAME_RE.test(username)) {
        return fail(400, "Username must be 3-20 letters, numbers or _.");
      }
      const problem = passwordProblem(password);
      if (problem) return fail(400, problem);
      if (await users.get(userKey(username))) return fail(409, "That username is taken.");

      const isFirst = (await users.keys()).length === 0;
      const user = { username, ...(await hashPassword(password)), isAdmin: isFirst, createdAt: Date.now(), sessions: [] };
      await users.set(userKey(username), user);

      // Optionally start the account with the progress already on this device
      const save = body.save;
      if (save && typeof save === "object" && JSON.stringify(save).length <= MAX_SAVE_BYTES) {
        await saves.set(userKey(username), { save, savedAt: Date.now() });
        user.totalBaked = num(save.totalBaked);
      }
      const token = await startSession(user);
      return json(200, { token, user: publicUser(user) });
    },

    async login(body) {
      const { username, password } = body;
      const user = typeof username === "string" ? await users.get(userKey(username)) : null;
      if (user && user.lockedUntil > Date.now()) {
        return fail(429, "Too many wrong passwords. Wait a few minutes and try again.");
      }
      if (!user || typeof password !== "string" || !(await passwordMatches(password, user))) {
        if (user) {
          user.failedLogins = (user.failedLogins || 0) + 1;
          if (user.failedLogins >= MAX_FAILED_LOGINS) {
            user.failedLogins = 0;
            user.lockedUntil = Date.now() + LOCK_MS;
          }
          await users.set(userKey(user.username), user);
        }
        return fail(401, "Wrong username or password.");
      }
      user.failedLogins = 0;
      user.lockedUntil = 0;
      const token = await startSession(user);
      return json(200, { token, user: publicUser(user) });
    },

    async logout(body, me) {
      await sessions.del(me.sessionKey);
      me.user.sessions = (me.user.sessions || []).filter((k) => k !== me.sessionKey);
      await users.set(userKey(me.user.username), me.user);
      return json(200, { ok: true });
    },

    async me(body, me) {
      return json(200, { user: publicUser(me.user) });
    },

    async save(body, me) {
      const save = body.save;
      if (!save || typeof save !== "object" || Array.isArray(save)) return fail(400, "Missing save.");
      if (JSON.stringify(save).length > MAX_SAVE_BYTES) return fail(413, "Save is too big.");
      // An admin edited this bakery since the player's game last loaded it:
      // refuse the upload and hand back the edited save for the game to switch to.
      const record = await saves.get(userKey(me.user.username));
      const adminRev = record ? record.adminRev || 0 : 0;
      if (num(save.adminRev) < adminRev) {
        return json(409, { error: "An admin changed your bakery.", save: record.save });
      }
      await saves.set(userKey(me.user.username), { save, savedAt: Date.now(), adminRev });
      // Keep leaderboard stats on the user record so the board is cheap to build
      me.user.totalBaked = num(save.totalBaked);
      me.user.skin = typeof save.skin === "string" ? save.skin.slice(0, 30) : "classic";
      await users.set(userKey(me.user.username), me.user);
      return json(200, { ok: true });
    },

    async load(body, me) {
      const record = await saves.get(userKey(me.user.username));
      return json(200, { save: record ? record.save : null });
    },

    async leaderboard() {
      const all = await Promise.all((await users.keys()).map((k) => users.get(k)));
      const rows = all.filter(Boolean)
        .map((u) => ({ username: u.username, totalBaked: num(u.totalBaked), skin: u.skin || "classic" }))
        .sort((a, b) => b.totalBaked - a.totalBaked)
        .slice(0, 50);
      return json(200, { rows });
    },

    async password(body, me) {
      if (!(await passwordMatches(String(body.oldPassword || ""), me.user))) return fail(401, "Your current password is wrong.");
      const problem = passwordProblem(body.newPassword);
      if (problem) return fail(400, problem);
      Object.assign(me.user, await hashPassword(body.newPassword));
      await endSessions(me.user, me.sessionKey); // log out other devices, stay logged in here
      await users.set(userKey(me.user.username), me.user);
      return json(200, { ok: true });
    },

    // ---------- Admin only ----------
    async "admin/users"() {
      const all = await Promise.all((await users.keys()).map((k) => users.get(k)));
      const rows = all.filter(Boolean)
        .map((u) => ({ username: u.username, isAdmin: !!u.isAdmin, totalBaked: num(u.totalBaked), createdAt: u.createdAt }))
        .sort((a, b) => a.username.localeCompare(b.username));
      return json(200, { users: rows });
    },

    // The admin's game edits a copy of the player's save and sends it back.
    async "admin/get-save"(body) {
      const target = typeof body.username === "string" ? await users.get(userKey(body.username)) : null;
      if (!target) return fail(404, "No such user.");
      const record = await saves.get(userKey(target.username));
      return json(200, { save: record ? record.save : null, savedAt: record ? record.savedAt : 0 });
    },

    async "admin/put-save"(body) {
      const target = typeof body.username === "string" ? await users.get(userKey(body.username)) : null;
      if (!target) return fail(404, "No such user.");
      const save = body.save;
      if (!save || typeof save !== "object" || Array.isArray(save)) return fail(400, "Missing save.");
      if (JSON.stringify(save).length > MAX_SAVE_BYTES) return fail(413, "Save is too big.");
      const record = await saves.get(userKey(target.username));
      // The player uploaded in between: the admin's game re-reads and tries again
      if ((record ? record.savedAt : 0) !== body.baseSavedAt) return fail(409, "The save changed, try again.");
      const adminRev = (record ? record.adminRev || 0 : 0) + 1;
      save.adminRev = adminRev;
      await saves.set(userKey(target.username), { save, savedAt: Date.now(), adminRev });
      target.totalBaked = num(save.totalBaked);
      target.skin = typeof save.skin === "string" ? save.skin.slice(0, 30) : "classic";
      await users.set(userKey(target.username), target);
      return json(200, { ok: true, save });
    },

    async "admin/set-password"(body) {
      const target = typeof body.username === "string" ? await users.get(userKey(body.username)) : null;
      if (!target) return fail(404, "No such user.");
      const problem = passwordProblem(body.newPassword);
      if (problem) return fail(400, problem);
      Object.assign(target, await hashPassword(body.newPassword), { failedLogins: 0, lockedUntil: 0 });
      await endSessions(target); // they log in again with the new password
      await users.set(userKey(target.username), target);
      return json(200, { ok: true });
    },

    async "admin/set-admin"(body, me) {
      const target = typeof body.username === "string" ? await users.get(userKey(body.username)) : null;
      if (!target) return fail(404, "No such user.");
      if (userKey(target.username) === userKey(me.user.username)) return fail(400, "You can't change your own admin status.");
      target.isAdmin = !!body.isAdmin;
      await users.set(userKey(target.username), target);
      return json(200, { ok: true });
    },

    async "admin/delete-user"(body, me) {
      const target = typeof body.username === "string" ? await users.get(userKey(body.username)) : null;
      if (!target) return fail(404, "No such user.");
      if (userKey(target.username) === userKey(me.user.username)) return fail(400, "You can't delete your own account.");
      await endSessions(target);
      await saves.del(userKey(target.username));
      await users.del(userKey(target.username));
      return json(200, { ok: true });
    },
  };

  const PUBLIC = new Set(["register", "login"]);

  return async function handle(req) {
    if (req.method !== "POST") return fail(405, "Use POST.");
    const action = new URL(req.url).pathname.replace(/^\/api\//, "").replace(/\/$/, "");
    const run = Object.hasOwn(actions, action) ? actions[action] : null;
    if (!run) return fail(404, "Unknown action.");

    let body = {};
    try { body = (await req.json()) || {}; } catch { body = {}; }
    if (typeof body !== "object" || Array.isArray(body)) body = {};

    try {
      if (PUBLIC.has(action)) return await run(body);
      const me = await authenticate(req);
      if (!me) return fail(401, "Please log in again.");
      if (action.startsWith("admin/") && !me.user.isAdmin) return fail(403, "Admins only.");
      return await run(body, me);
    } catch (e) {
      console.error(e);
      return fail(500, "Server error. Try again in a moment.");
    }
  };
}
