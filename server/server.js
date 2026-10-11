// CloudStation-4 backend (Node.js + Express + libSQL / Turso)
// Env:
//   ADMIN_KEY, PS4_KEY      secrets for the owner app / PS4 app
//   TURSO_DATABASE_URL      libsql://... (Turso, free, persistent). If unset, a local file data.db is used.
//   TURSO_AUTH_TOKEN        Turso auth token
//   PORT
const express = require("express");
const { createClient } = require("@libsql/client");
const crypto = require("crypto");

const ADMIN_KEY = process.env.ADMIN_KEY || "change-me-admin";
const PS4_KEY = process.env.PS4_KEY || "change-me-ps4";
const PORT = process.env.PORT || 3000;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:data.db",
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ---------- DB helpers (all async, rows returned as plain objects) ----------
async function q(sql, args = []) {
  const r = await db.execute({ sql, args });
  return r.rows.map((row) => ({ ...row }));
}
async function one(sql, args = []) {
  return (await q(sql, args))[0];
}
async function run(sql, args = []) {
  const r = await db.execute({ sql, args });
  return {
    changes: r.rowsAffected,
    lastId: r.lastInsertRowid !== undefined && r.lastInsertRowid !== null ? Number(r.lastInsertRowid) : null,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY, label TEXT, status TEXT DEFAULT 'active', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, device_id TEXT, name TEXT,
  token TEXT UNIQUE, status TEXT DEFAULT 'active', muted INTEGER DEFAULT 0,
  created_at INTEGER, last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS hosts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, key_hash TEXT UNIQUE,
  state TEXT DEFAULT 'idle', game TEXT, last_seen INTEGER DEFAULT 0, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, user_id INTEGER, host_id INTEGER,
  status TEXT DEFAULT 'open', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, game TEXT,
  started_at INTEGER, last_ping INTEGER, ended_at INTEGER
);
`;

const app = express();
app.use(express.json());
const now = () => Math.floor(Date.now() / 1000);
const newCode = () => crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 chars
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- middleware ----------
const adminOnly = (req, res, next) =>
  req.get("x-admin-key") === ADMIN_KEY ? next() : res.status(401).json({ error: "admin only" });
const ps4Only = (req, res, next) =>
  req.get("x-ps4-key") === PS4_KEY ? next() : res.status(401).json({ error: "ps4 only" });
const userAuth = wrap(async (req, res, next) => {
  const token = (req.get("authorization") || "").replace("Bearer ", "");
  const u = token ? await one("SELECT * FROM users WHERE token = ?", [token]) : undefined;
  if (!u) return res.status(401).json({ error: "invalid token" });
  if (u.status === "banned") return res.status(403).json({ error: "banned" });
  await run("UPDATE users SET last_seen = ? WHERE id = ?", [now(), u.id]);
  req.user = u;
  next();
});
const hostAuth = wrap(async (req, res, next) => {
  const h = await one("SELECT * FROM hosts WHERE key_hash = ?", [sha(req.get("x-host-key") || "")]);
  if (!h) return res.status(401).json({ error: "invalid host key" });
  req.hostRow = h;
  next();
});

app.get("/", (_req, res) => res.json({ ok: true, service: "cloudstation-4" }));

// ---------- client app ----------
// Redeem a code: binds it to the first device that uses it.
app.post("/api/redeem", wrap(async (req, res) => {
  const { code, deviceId, name } = req.body || {};
  if (!code || !deviceId) return res.status(400).json({ error: "code and deviceId required" });
  const c = await one("SELECT * FROM codes WHERE code = ?", [String(code).toUpperCase()]);
  if (!c || c.status !== "active") return res.status(403).json({ error: "invalid code" });

  const u = await one("SELECT * FROM users WHERE code = ?", [c.code]);
  if (u) {
    if (u.device_id !== deviceId) return res.status(403).json({ error: "code used on another device" });
    if (u.status === "banned") return res.status(403).json({ error: "banned" });
    return res.json({ token: u.token, muted: !!u.muted });
  }
  const token = crypto.randomBytes(24).toString("hex");
  await run(
    "INSERT INTO users (code, device_id, name, token, created_at, last_seen) VALUES (?,?,?,?,?,?)",
    [c.code, deviceId, name || c.label || "user", token, now(), now()]
  );
  res.json({ token, muted: false });
}));

app.get("/api/me", userAuth, (req, res) =>
  res.json({ name: req.user.name, status: req.user.status, muted: !!req.user.muted })
);

app.post("/api/session/start", userAuth, wrap(async (req, res) => {
  const r = await run(
    "INSERT INTO sessions (user_id, game, started_at, last_ping) VALUES (?,?,?,?)",
    [req.user.id, req.body.game || null, now(), now()]
  );
  res.json({ sessionId: r.lastId });
}));
app.post("/api/session/ping", userAuth, wrap(async (req, res) => {
  await run(
    "UPDATE sessions SET last_ping = ?, game = COALESCE(?, game) WHERE id = ? AND user_id = ? AND ended_at IS NULL",
    [now(), req.body.game || null, req.body.sessionId ?? null, req.user.id]
  );
  res.json({ ok: true, muted: !!req.user.muted });
}));
app.post("/api/session/end", userAuth, wrap(async (req, res) => {
  await run("UPDATE sessions SET ended_at = ? WHERE id = ? AND user_id = ?", [now(), req.body.sessionId ?? null, req.user.id]);
  res.json({ ok: true });
}));

// client app: ask for a free host
app.post("/api/connect", userAuth, wrap(async (req, res) => {
  const t = now();
  await run("UPDATE tickets SET status = 'closed' WHERE status = 'open' AND created_at < ?", [t - 60]);
  await run(
    `UPDATE tickets SET status = 'closed' WHERE status = 'claimed'
     AND user_id IN (SELECT id FROM users WHERE last_seen < ?)`,
    [t - 90]
  );
  await run("UPDATE tickets SET status = 'closed' WHERE user_id = ? AND status IN ('open','claimed')", [req.user.id]);
  const host = await one(
    `SELECT h.* FROM hosts h WHERE h.last_seen > ? AND h.state = 'idle'
     AND NOT EXISTS (SELECT 1 FROM tickets x WHERE x.host_id = h.id AND x.status IN ('open','claimed'))
     ORDER BY h.last_seen DESC LIMIT 1`,
    [t - 30]
  );
  if (!host) return res.status(503).json({ error: "no host available" });
  const id = crypto.randomBytes(12).toString("hex");
  await run("INSERT INTO tickets (id, user_id, host_id, created_at) VALUES (?,?,?,?)", [id, req.user.id, host.id, t]);
  res.json({ ticket: id, hostId: host.id });
}));
app.get("/api/ticket/:id", userAuth, wrap(async (req, res) => {
  const t = await one("SELECT status, host_id FROM tickets WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
  if (!t) return res.status(404).json({ error: "not found" });
  res.json(t);
}));

// ---------- owner (admin) app ----------
app.post("/admin/codes", adminOnly, wrap(async (req, res) => {
  const code = newCode();
  await run("INSERT INTO codes (code, label, created_at) VALUES (?,?,?)", [code, req.body.label || "", now()]);
  res.json({ code });
}));
app.get("/admin/codes", adminOnly, wrap(async (_req, res) => {
  res.json(await q("SELECT * FROM codes ORDER BY created_at DESC"));
}));
app.post("/admin/codes/:code/revoke", adminOnly, wrap(async (req, res) => {
  await run("UPDATE codes SET status = 'revoked' WHERE code = ?", [req.params.code]);
  res.json({ ok: true });
}));

app.get("/admin/users", adminOnly, wrap(async (_req, res) => {
  const rows = await q(
    `SELECT u.id, u.name, u.code, u.status, u.muted, u.last_seen,
       COALESCE(SUM(COALESCE(s.ended_at, s.last_ping) - s.started_at), 0) AS total_seconds,
       (SELECT game FROM sessions WHERE user_id = u.id ORDER BY id DESC LIMIT 1) AS last_game,
       EXISTS(SELECT 1 FROM sessions WHERE user_id = u.id AND ended_at IS NULL AND last_ping > ?) AS online
     FROM users u LEFT JOIN sessions s ON s.user_id = u.id GROUP BY u.id ORDER BY u.last_seen DESC`,
    [now() - 60]
  );
  res.json(rows.map((r) => ({ ...r, hours: +(r.total_seconds / 3600).toFixed(2), online: !!r.online })));
}));
const setStatus = (status) => wrap(async (req, res) => {
  await run("UPDATE users SET status = ? WHERE id = ?", [status, Number(req.params.id)]);
  res.json({ ok: true });
});
const setMuted = (value) => wrap(async (req, res) => {
  await run("UPDATE users SET muted = ? WHERE id = ?", [value, Number(req.params.id)]);
  res.json({ ok: true });
});
app.post("/admin/users/:id/ban", adminOnly, setStatus("banned"));
app.post("/admin/users/:id/unban", adminOnly, setStatus("active"));
app.post("/admin/users/:id/mute", adminOnly, setMuted(1));
app.post("/admin/users/:id/unmute", adminOnly, setMuted(0));
app.delete("/admin/users/:id", adminOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  // Deleting a user also revokes their code, otherwise the same code could simply be re-entered.
  const u = await one("SELECT code FROM users WHERE id = ?", [id]);
  if (u) await run("UPDATE codes SET status = 'revoked' WHERE code = ?", [u.code]);
  await run("UPDATE tickets SET status = 'closed' WHERE user_id = ?", [id]);
  await run("DELETE FROM sessions WHERE user_id = ?", [id]);
  await run("DELETE FROM users WHERE id = ?", [id]);
  res.json({ ok: true });
}));
app.get("/admin/sessions", adminOnly, wrap(async (_req, res) => {
  res.json(await q("SELECT s.*, u.name FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT 200"));
}));

// ---------- hosts (iPhone relay between PS4 and users) ----------
// owner: create / list / delete hosts (host key is shown once)
app.post("/admin/hosts", adminOnly, wrap(async (req, res) => {
  const key = crypto.randomBytes(24).toString("hex");
  const r = await run("INSERT INTO hosts (name, key_hash, created_at) VALUES (?,?,?)", [req.body.name || "host", sha(key), now()]);
  res.json({ id: r.lastId, key });
}));
app.get("/admin/hosts", adminOnly, wrap(async (_req, res) => {
  const rows = await q("SELECT id, name, state, game, last_seen FROM hosts ORDER BY id");
  res.json(rows.map((h) => ({ ...h, online: h.last_seen > now() - 30 })));
}));
app.delete("/admin/hosts/:id", adminOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  await run("UPDATE tickets SET status = 'closed' WHERE host_id = ?", [id]);
  await run("DELETE FROM hosts WHERE id = ?", [id]);
  res.json({ ok: true });
}));

// host app: heartbeat every ~5s. Reply lists tickets the host must disconnect (banned/deleted users).
app.post("/host/heartbeat", hostAuth, wrap(async (req, res) => {
  await run("UPDATE hosts SET state = ?, game = ?, last_seen = ? WHERE id = ?", [
    req.body.state || "idle",
    req.body.game || null,
    now(),
    req.hostRow.id,
  ]);
  const bad = await q(
    `SELECT t.id FROM tickets t LEFT JOIN users u ON u.id = t.user_id
     WHERE t.host_id = ? AND t.status IN ('open','claimed') AND (u.id IS NULL OR u.status = 'banned')`,
    [req.hostRow.id]
  );
  res.json({ disconnect: bad.map((b) => b.id) });
}));
// host app: poll for users who were assigned to it
app.get("/host/tickets", hostAuth, wrap(async (req, res) => {
  const rows = await q(
    `SELECT t.id AS ticket, u.id AS userId, u.name, u.muted FROM tickets t
     JOIN users u ON u.id = t.user_id WHERE t.host_id = ? AND t.status = 'open'`,
    [req.hostRow.id]
  );
  for (const r of rows) await run("UPDATE tickets SET status = 'claimed' WHERE id = ?", [r.ticket]);
  res.json(rows.map((r) => ({ ...r, muted: !!r.muted })));
}));
app.post("/host/tickets/:id/close", hostAuth, wrap(async (req, res) => {
  await run("UPDATE tickets SET status = 'closed' WHERE id = ? AND host_id = ?", [req.params.id, req.hostRow.id]);
  res.json({ ok: true });
}));

// ---------- PS4 PKG app ----------
// The PKG app polls this to show who is connected and what they play.
app.get("/ps4/active", ps4Only, wrap(async (_req, res) => {
  res.json(
    await q(
      `SELECT u.id, u.name, s.game, s.started_at FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.ended_at IS NULL AND s.last_ping > ? AND u.status = 'active'`,
      [now() - 60]
    )
  );
}));
// PKG reports the game currently running on the console.
app.post("/ps4/report", ps4Only, wrap(async (req, res) => {
  await run("UPDATE sessions SET game = ? WHERE ended_at IS NULL AND last_ping > ?", [req.body.game || null, now() - 60]);
  res.json({ ok: true });
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "server error" });
});

(async () => {
  await db.executeMultiple(SCHEMA);
  app.listen(PORT, () => console.log("CloudStation-4 server on :" + PORT));
})().catch((e) => {
  console.error("startup failed", e);
  process.exit(1);
});
