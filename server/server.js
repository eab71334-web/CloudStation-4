// PS4 Cloud - Backend (Node.js + Express + SQLite)
// Env: ADMIN_KEY (owner app), PS4_KEY (PKG app), PORT
const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const ADMIN_KEY = process.env.ADMIN_KEY || "change-me-admin";
const PS4_KEY = process.env.PS4_KEY || "change-me-ps4";
const PORT = process.env.PORT || 3000;

const db = new Database("data.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS codes (
  code TEXT PRIMARY KEY, label TEXT, status TEXT DEFAULT 'active', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, device_id TEXT, name TEXT,
  token TEXT UNIQUE, status TEXT DEFAULT 'active', muted INTEGER DEFAULT 0,
  created_at INTEGER, last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, game TEXT,
  started_at INTEGER, last_ping INTEGER, ended_at INTEGER
);
`);

const app = express();
app.use(express.json());
const now = () => Math.floor(Date.now() / 1000);
const newCode = () => crypto.randomBytes(4).toString("hex").toUpperCase(); // 8 chars

// ---------- middleware ----------
const adminOnly = (req, res, next) =>
  req.get("x-admin-key") === ADMIN_KEY ? next() : res.status(401).json({ error: "admin only" });
const ps4Only = (req, res, next) =>
  req.get("x-ps4-key") === PS4_KEY ? next() : res.status(401).json({ error: "ps4 only" });
const userAuth = (req, res, next) => {
  const token = (req.get("authorization") || "").replace("Bearer ", "");
  const u = db.prepare("SELECT * FROM users WHERE token = ?").get(token);
  if (!u) return res.status(401).json({ error: "invalid token" });
  if (u.status === "banned") return res.status(403).json({ error: "banned" });
  db.prepare("UPDATE users SET last_seen = ? WHERE id = ?").run(now(), u.id);
  req.user = u;
  next();
};

// ---------- client app ----------
// Redeem a code: binds it to the first device that uses it.
app.post("/api/redeem", (req, res) => {
  const { code, deviceId, name } = req.body || {};
  if (!code || !deviceId) return res.status(400).json({ error: "code and deviceId required" });
  const c = db.prepare("SELECT * FROM codes WHERE code = ?").get(String(code).toUpperCase());
  if (!c || c.status !== "active") return res.status(403).json({ error: "invalid code" });

  let u = db.prepare("SELECT * FROM users WHERE code = ?").get(c.code);
  if (u) {
    if (u.device_id !== deviceId) return res.status(403).json({ error: "code used on another device" });
    if (u.status === "banned") return res.status(403).json({ error: "banned" });
    return res.json({ token: u.token, muted: !!u.muted });
  }
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare(
    "INSERT INTO users (code, device_id, name, token, created_at, last_seen) VALUES (?,?,?,?,?,?)"
  ).run(c.code, deviceId, name || c.label || "user", token, now(), now());
  res.json({ token, muted: false });
});

app.get("/api/me", userAuth, (req, res) =>
  res.json({ name: req.user.name, status: req.user.status, muted: !!req.user.muted })
);

app.post("/api/session/start", userAuth, (req, res) => {
  const r = db
    .prepare("INSERT INTO sessions (user_id, game, started_at, last_ping) VALUES (?,?,?,?)")
    .run(req.user.id, req.body.game || null, now(), now());
  res.json({ sessionId: r.lastInsertRowid });
});
app.post("/api/session/ping", userAuth, (req, res) => {
  db.prepare("UPDATE sessions SET last_ping = ?, game = COALESCE(?, game) WHERE id = ? AND user_id = ? AND ended_at IS NULL")
    .run(now(), req.body.game || null, req.body.sessionId, req.user.id);
  res.json({ ok: true, muted: !!req.user.muted });
});
app.post("/api/session/end", userAuth, (req, res) => {
  db.prepare("UPDATE sessions SET ended_at = ? WHERE id = ? AND user_id = ?")
    .run(now(), req.body.sessionId, req.user.id);
  res.json({ ok: true });
});

// ---------- owner (admin) app ----------
app.post("/admin/codes", adminOnly, (req, res) => {
  const code = newCode();
  db.prepare("INSERT INTO codes (code, label, created_at) VALUES (?,?,?)").run(code, req.body.label || "", now());
  res.json({ code });
});
app.get("/admin/codes", adminOnly, (_req, res) => res.json(db.prepare("SELECT * FROM codes ORDER BY created_at DESC").all()));
app.post("/admin/codes/:code/revoke", adminOnly, (req, res) => {
  db.prepare("UPDATE codes SET status = 'revoked' WHERE code = ?").run(req.params.code);
  res.json({ ok: true });
});

app.get("/admin/users", adminOnly, (_req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.name, u.code, u.status, u.muted, u.last_seen,
      COALESCE(SUM(COALESCE(s.ended_at, s.last_ping) - s.started_at), 0) AS total_seconds,
      (SELECT game FROM sessions WHERE user_id = u.id ORDER BY id DESC LIMIT 1) AS last_game,
      EXISTS(SELECT 1 FROM sessions WHERE user_id = u.id AND ended_at IS NULL AND last_ping > ?) AS online
    FROM users u LEFT JOIN sessions s ON s.user_id = u.id GROUP BY u.id ORDER BY u.last_seen DESC`).all(now() - 60);
  res.json(rows.map((r) => ({ ...r, hours: +(r.total_seconds / 3600).toFixed(2), online: !!r.online })));
});
const setStatus = (status) => (req, res) => {
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(status, req.params.id);
  res.json({ ok: true });
};
app.post("/admin/users/:id/ban", adminOnly, setStatus("banned"));
app.post("/admin/users/:id/unban", adminOnly, setStatus("active"));
app.post("/admin/users/:id/mute", adminOnly, (req, res) => {
  db.prepare("UPDATE users SET muted = 1 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
app.post("/admin/users/:id/unmute", adminOnly, (req, res) => {
  db.prepare("UPDATE users SET muted = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
app.delete("/admin/users/:id", adminOnly, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(req.params.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
app.get("/admin/sessions", adminOnly, (_req, res) =>
  res.json(db.prepare(`SELECT s.*, u.name FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY s.id DESC LIMIT 200`).all())
);

// ---------- PS4 PKG app ----------
// The PKG app polls this to show who is connected and what they play.
app.get("/ps4/active", ps4Only, (_req, res) =>
  res.json(
    db.prepare(`SELECT u.id, u.name, s.game, s.started_at FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.ended_at IS NULL AND s.last_ping > ? AND u.status = 'active'`).all(now() - 60)
  )
);
// PKG reports the game currently running on the console.
app.post("/ps4/report", ps4Only, (req, res) => {
  db.prepare("UPDATE sessions SET game = ? WHERE ended_at IS NULL AND last_ping > ?").run(req.body.game || null, now() - 60);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log("PS4 Cloud server on :" + PORT));
