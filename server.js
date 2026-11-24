// Grathia Sweet Haven — Shop Manager (secure edition)
// Start:  npm install   then   npm start   then open http://localhost:3000
// Online: deployed on Vercel with a Turso database (see README).
"use strict";
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const ExcelJS = require("exceljs");
const { db, ready, backupToFile, isRemote, DATA_DIR } = require("./db");
const { SHOP_TZ, localDate, timeHM, dayStart, dayEnd } = require("./time");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const SESSION_MAX_DAYS = 7;                 // absolute session lifetime
const LOCK_AFTER = 5, LOCK_MINUTES = 15;    // failed logins before lock-out
const app = express();
app.disable("x-powered-by");
if (process.env.TRUST_PROXY || process.env.VERCEL) app.set("trust proxy", 1);

// ======================================================================
// Security headers on every response
// ======================================================================
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join("; "));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

// ======================================================================
// Helpers
// ======================================================================
const now = () => Date.now();
const str = (v, max = 120) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
const num = (v) => { const x = parseFloat(String(v ?? "").replace(/,/g, "")); return Number.isFinite(x) ? x : 0; };
const money = (v) => Math.round(num(v) * 100) / 100;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ipOf = (req) => String(req.ip || req.socket.remoteAddress || "").replace("::ffff:", "");
async function settings() { return Object.fromEntries((await db.all("SELECT key, value FROM settings")).map((r) => [r.key, r.value])); }
const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
async function audit(req, action, detail = "") {
  await db.run("INSERT INTO audit (t, user_id, action, detail, ip) VALUES (?,?,?,?,?)", now(), req.user?.id ?? null, action, String(detail).slice(0, 500), ipOf(req));
}
function passwordProblem(pw, username) {
  if (typeof pw !== "string" || pw.length < 8) return "Password must be at least 8 characters.";
  if (pw.length > 200) return "Password is too long.";
  if (username && pw.toLowerCase() === username.toLowerCase()) return "Your password cannot be the same as your username.";
  return null;
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };
const wrap = (fn) => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } };

// Wait for the database to be ready (first request after a cold start).
app.use("/api", wrap(async (req, res, next) => { await ready; next(); }));

// ======================================================================
// Roles & permissions (checked on the server for every request)
// ======================================================================
const PERMS = {
  cashier: ["sell", "sales.view", "stock.view", "stock.in", "stock.loss", "expense.add", "expense.view", "daybook", "customers"],
  manager: ["sell", "sales.view", "stock.view", "stock.in", "stock.loss", "expense.add", "expense.view", "daybook", "customers",
    "sales.void", "price.override", "items.manage", "stock.count", "stock.void", "expense.void", "costs.view", "reports", "export"],
  admin: null, // admin has every permission
};
const ALL_PERMS = [...new Set(Object.values(PERMS).filter(Boolean).flat()), "users", "audit", "settings", "backup"];
const permsOf = (role) => (role === "admin" ? ALL_PERMS : PERMS[role] || []);
const can = (user, p) => !!user && permsOf(user.role).includes(p);

// ======================================================================
// CSRF protection: every state-changing API call must come from our own page
// (custom header + same origin). Browsers cannot add this header cross-site.
// ======================================================================
app.use("/api", (req, res, next) => {
  if (["GET", "HEAD"].includes(req.method)) return next();
  if (req.get("X-Requested-With") !== "GrathiaApp") return res.status(403).json({ error: "Request blocked (CSRF check)." });
  const origin = req.get("Origin");
  if (origin) { let host = ""; try { host = new URL(origin).host; } catch {} if (host !== req.get("Host")) return res.status(403).json({ error: "Request blocked (wrong origin)." }); }
  next();
});

// ======================================================================
// Sessions
// ======================================================================
function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.secure ? "; Secure" : "";
  res.setHeader("Set-Cookie", `gsid=${token}; HttpOnly; SameSite=Strict; Path=/${secure}; Max-Age=${maxAgeSec}`);
}
app.use("/api", wrap(async (req, res, next) => {
  const token = readCookie(req, "gsid");
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return next();
  const h = sha256(token);
  const row = await db.get("SELECT s.created_t, s.last_seen_t, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", h);
  if (!row) return next();
  const idleMs = Math.max(5, num((await settings()).idle_minutes) || 30) * 60e3;
  const expired = now() - row.created_t > SESSION_MAX_DAYS * 864e5 || now() - row.last_seen_t > idleMs || row.status !== "active";
  if (expired) { await db.run("DELETE FROM sessions WHERE token_hash = ?", h); setSessionCookie(req, res, "", 0); return next(); }
  if (now() - row.last_seen_t > 30e3) await db.run("UPDATE sessions SET last_seen_t = ? WHERE token_hash = ?", now(), h);
  req.user = row; req.sessionHash = h;
  next();
}));
const auth = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Please log in.", code: "login" });
  if (req.user.must_change) return res.status(403).json({ error: "Please set a new password first.", code: "must_change" });
  next();
};
const need = (...ps) => (req, res, next) => ps.every((p) => can(req.user, p)) ? next() : res.status(403).json({ error: "You don't have permission to do this." });
const pubUser = (u) => u && { id: u.id, name: u.name, username: u.username, phone: u.phone, role: u.role, status: u.status, must_change: !!u.must_change };

// ======================================================================
// Login lock-out (per username and per IP), stored in the database so it
// works across all server instances.
// ======================================================================
async function lockedFor(key) {
  const f = await db.get("SELECT until FROM login_fails WHERE key = ?", key);
  return f && f.until > now() ? Math.ceil((f.until - now()) / 60000) : 0;
}
async function addFail(key) {
  const { n } = await db.get("INSERT INTO login_fails (key, n, until) VALUES (?, 1, 0) ON CONFLICT(key) DO UPDATE SET n = n + 1 RETURNING n", key);
  if (n >= LOCK_AFTER) await db.run("UPDATE login_fails SET n = 0, until = ? WHERE key = ?", now() + LOCK_MINUTES * 60e3, key);
}
const clearFails = (key) => db.run("DELETE FROM login_fails WHERE key = ?", key);

// ======================================================================
// Auth routes
// ======================================================================
app.post("/api/auth/register", wrap(async (req, res) => {
  const name = str(req.body.name, 60), username = str(req.body.username, 30).toLowerCase(), phone = str(req.body.phone, 30), pw = req.body.password;
  if (!name) bad("Please enter your full name.");
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) bad("Username must have no spaces — for example: grace or grace.u (letters, numbers, dots or dashes).");
  const p = passwordProblem(pw, username); if (p) bad(p);
  if (await lockedFor("reg:" + ipOf(req))) bad("Too many sign-ups from this device. Try later.");
  await addFail("reg:" + ipOf(req)); // slows down mass sign-ups (5 per 15 minutes per device)
  if (await db.get("SELECT 1 FROM users WHERE username = ?", username)) bad("That username is taken. Choose another.");
  const salt = crypto.randomBytes(16).toString("hex"), hash = hashPw(pw, salt);
  const { id, first } = await db.tx(async (t) => {
    const first = (await t.get("SELECT COUNT(*) AS c FROM users")).c === 0;
    const id = (await t.run("INSERT INTO users (name, username, phone, pass_hash, salt, role, status, created_t) VALUES (?,?,?,?,?,?,?,?)",
      name, username, phone, hash, salt, first ? "admin" : "cashier", first ? "active" : "pending", now())).lastInsertRowid;
    return { id, first };
  });
  req.user = { id }; await audit(req, "account.created", `${username}${first ? " (first user → admin)" : " (waiting for approval)"}`);
  res.json({ ok: true, message: first ? "You are the first user, so you are the administrator. You can log in now." : "Account created. An administrator must approve it before you can log in." });
}));

app.post("/api/auth/login", wrap(async (req, res) => {
  const username = str(req.body.username, 30).toLowerCase(), pw = String(req.body.password || "");
  const kU = "u:" + username, kI = "ip:" + ipOf(req);
  const lock = Math.max(await lockedFor(kU), await lockedFor(kI));
  if (lock) return res.status(429).json({ error: `Too many wrong attempts. Try again in ${lock} minute${lock > 1 ? "s" : ""}.` });
  const u = await db.get("SELECT * FROM users WHERE username = ?", username);
  const ok = u ? safeEq(hashPw(pw, u.salt), u.pass_hash) : (hashPw(pw, "dummy-salt-for-timing"), false);
  if (!ok) { await addFail(kU); await addFail(kI); req.user = u ? { id: u.id } : null; await audit(req, "login.failed", username); return res.status(401).json({ error: "Wrong username or password." }); }
  await clearFails(kU);
  if (u.status === "pending") return res.status(403).json({ error: "Your account is waiting for an administrator to approve it." });
  if (u.status === "disabled") return res.status(403).json({ error: "Your account is switched off. Speak to the shop owner." });
  const token = crypto.randomBytes(32).toString("hex");
  await db.run("INSERT INTO sessions (token_hash, user_id, created_t, last_seen_t, ip, agent) VALUES (?,?,?,?,?,?)", sha256(token), u.id, now(), now(), ipOf(req), str(req.get("User-Agent"), 200));
  await db.run("UPDATE users SET last_login_t = ? WHERE id = ?", now(), u.id);
  // House-keeping: remove expired sessions and old lock-out counters.
  await db.run("DELETE FROM sessions WHERE created_t < ?", now() - SESSION_MAX_DAYS * 864e5);
  await db.run("DELETE FROM login_fails WHERE until < ? AND n = 0", now());
  setSessionCookie(req, res, token, SESSION_MAX_DAYS * 86400);
  req.user = u; await audit(req, "login.ok");
  res.json({ ok: true, user: pubUser(u) });
}));

app.post("/api/auth/logout", wrap(async (req, res) => {
  if (req.sessionHash) { await db.run("DELETE FROM sessions WHERE token_hash = ?", req.sessionHash); await audit(req, "logout"); }
  setSessionCookie(req, res, "", 0); res.json({ ok: true });
}));

app.get("/api/auth/me", wrap(async (req, res) => {
  const s = await settings();
  res.json({ user: pubUser(req.user) || null, perms: req.user ? permsOf(req.user.role) : [],
    shop: { name: s.shop_name, tagline: s.shop_tagline, address: s.shop_address, phone: s.shop_phone, footer: s.receipt_footer, currency: s.currency, idle_minutes: num(s.idle_minutes) || 30 } });
}));

app.post("/api/auth/password", wrap(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Please log in." });
  if (!safeEq(hashPw(String(req.body.current || ""), req.user.salt), req.user.pass_hash)) bad("Your current password is wrong.");
  const p = passwordProblem(req.body.next, req.user.username); if (p) bad(p);
  if (req.body.next === req.body.current) bad("Choose a password different from the old one.");
  const salt = crypto.randomBytes(16).toString("hex");
  await db.run("UPDATE users SET pass_hash = ?, salt = ?, must_change = 0 WHERE id = ?", hashPw(req.body.next, salt), salt, req.user.id);
  await db.run("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?", req.user.id, req.sessionHash); // log out other devices
  await audit(req, "password.changed"); res.json({ ok: true });
}));

// ======================================================================
// Shared data
// ======================================================================
async function stockLevels(upto, q = db) {
  const dm = upto ? "AND date <= ?" : "", ds = upto ? "AND s.date <= ?" : "";
  const rows = await q.all(`SELECT p.*, COALESCE(m.q,0) AS moved, COALESCE(s.q,0) AS sold
    FROM products p
    LEFT JOIN (SELECT product_id, SUM(qty) q FROM stock_moves WHERE voided = 0 ${dm} GROUP BY product_id) m ON m.product_id = p.id
    LEFT JOIN (SELECT si.product_id, SUM(si.qty) q FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.voided = 0 ${ds} GROUP BY si.product_id) s ON s.product_id = p.id
    ORDER BY p.category, p.name`, ...(upto ? [upto, upto] : []));
  return rows.map((r) => { const on = r.moved - r.sold; return { ...r, on_hand: Math.round(on * 1000) / 1000,
    status: on < 0 ? "check" : on === 0 && r.reorder === 0 ? "none" : on <= r.reorder ? "low" : "ok" }; });
}
const productOut = (p, user) => { const o = { id: p.id, sku: p.sku, name: p.name, category: p.category, unit: p.unit, price: p.price, reorder: p.reorder,
  sellable: !!p.sellable, archived: !!p.archived, on_hand: p.on_hand, status: p.status }; if (can(user, "costs.view")) o.cost = p.cost; return o; };
const userNames = async () => Object.fromEntries((await db.all("SELECT id, name FROM users")).map((u) => [u.id, u.name]));

app.get("/api/bootstrap", auth, wrap(async (req, res) => {
  const [s, levels, customers, names] = await Promise.all([settings(), stockLevels(), db.all("SELECT id, name, phone FROM customers ORDER BY name"), userNames()]);
  res.json({
    products: levels.map((p) => productOut(p, req.user)),
    customers, names,
    lists: { categories: list(s.categories), expense_categories: list(s.expense_categories), payment_methods: list(s.payment_methods) },
    allow_negative: s.allow_negative_stock === "1",
    allow_custom: s.allow_custom_items === "1",
  });
}));

// ======================================================================
// Dashboard
// ======================================================================
app.get("/api/dashboard", auth, wrap(async (req, res) => {
  const today = localDate(), d14 = localDate(new Date(Date.now() - 13 * 864e5)), d30 = localDate(new Date(Date.now() - 29 * 864e5));
  const month = today.slice(0, 7) + "-01";
  const sum = async (sql, ...a) => (await db.get(sql, ...a)).v || 0;
  const salesBetween = (a, b) => sum("SELECT SUM(total) v FROM sales WHERE voided=0 AND date BETWEEN ? AND ?", a, b);
  const expBetween = (a, b) => sum("SELECT SUM(amount) v FROM expenses WHERE voided=0 AND date BETWEEN ? AND ?", a, b);
  const [series, top, levels, todaySales, todayReceipts, todayExp, monthSales, monthExp, recent] = await Promise.all([
    db.all("SELECT date, SUM(total) v, COUNT(*) n FROM sales WHERE voided=0 AND date BETWEEN ? AND ? GROUP BY date", d14, today),
    db.all(`SELECT si.name, SUM(si.qty) q, SUM(si.line_total) v FROM sale_items si JOIN sales s ON s.id=si.sale_id
      WHERE s.voided=0 AND s.date BETWEEN ? AND ? GROUP BY COALESCE(si.product_id, 'c:' || si.name) ORDER BY v DESC LIMIT 5`, d30, today),
    stockLevels(),
    salesBetween(today, today), sum("SELECT COUNT(*) v FROM sales WHERE voided=0 AND date=?", today), expBetween(today, today),
    salesBetween(month, today), expBetween(month, today),
    db.all("SELECT receipt_no, t, total, method, customer, user_id FROM sales WHERE voided=0 ORDER BY t DESC LIMIT 6"),
  ]);
  const byDay = Object.fromEntries(series.map((r) => [r.date, r.v]));
  const days = []; for (let i = 13; i >= 0; i--) { const d = localDate(new Date(Date.now() - i * 864e5)); days.push({ date: d, sales: byDay[d] || 0 }); }
  const low = levels.filter((p) => !p.archived && (p.status === "low" || p.status === "check")).map((p) => ({ id: p.id, name: p.name, unit: p.unit, on_hand: p.on_hand, reorder: p.reorder }));
  const out = {
    today: { sales: todaySales, receipts: todayReceipts, expenses: todayExp },
    month: { sales: monthSales, expenses: monthExp },
    days, top, low, recent,
  };
  if (can(req.user, "reports")) {
    const [cogs, loss] = await Promise.all([
      sum(`SELECT SUM(si.qty*si.cost) v FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.voided=0 AND s.date BETWEEN ? AND ?`, month, today),
      sum(`SELECT SUM(-qty*unit_cost) v FROM stock_moves WHERE voided=0 AND type IN ('damaged','expired','gift') AND date BETWEEN ? AND ?`, month, today),
    ]);
    out.month.profit = out.month.sales - cogs - out.month.expenses - loss;
  }
  res.json(out);
}));

// ======================================================================
// Sales (point of sale)
// ======================================================================
app.post("/api/sales", auth, need("sell"), wrap(async (req, res) => {
  const b = req.body || {}, date = isDate(b.date) ? b.date : localDate();
  if (date !== localDate() && !can(req.user, "sales.void")) bad("Only a manager can record a sale on another date.");
  const s = await settings(), methods = list(s.payment_methods);
  const method = methods.includes(b.method) ? b.method : bad("Choose how the customer paid.");
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 100) bad("The cart is empty.");
  const levels = Object.fromEntries((await stockLevels()).map((p) => [p.id, p]));
  const lines = b.items.map((it) => {
    if (it.custom) {
      if (s.allow_custom_items !== "1") bad("Custom items are switched off in Settings.");
      const name = str(it.name, 80); if (!name) bad("Give the custom item a name.");
      const qty = num(it.qty); if (qty <= 0 || qty > 100000) bad(`Check the quantity for ${name}.`);
      const price = money(it.price); if (price < 0) bad("Price cannot be negative.");
      const cost = can(req.user, "costs.view") ? Math.max(0, money(it.cost)) : 0;
      return { p: { id: null, name }, qty, price, cost, line: money(qty * price), custom: true };
    }
    const p = levels[num(it.product_id)]; if (!p || p.archived || !p.sellable) bad("An item in the cart is not for sale.");
    const qty = num(it.qty); if (qty <= 0 || qty > 100000) bad(`Check the quantity for ${p.name}.`);
    let price = p.price; if (it.price != null && money(it.price) !== p.price) { if (!can(req.user, "price.override")) bad("Only a manager can change prices."); price = money(it.price); }
    if (price < 0) bad("Price cannot be negative.");
    return { p, qty, price, cost: p.cost, line: money(qty * price) };
  });
  if (s.allow_negative_stock !== "1") {
    const need = {}; for (const l of lines) if (!l.custom) need[l.p.id] = (need[l.p.id] || 0) + l.qty;
    for (const [id, q] of Object.entries(need)) if (levels[id].on_hand < q) bad(`Not enough ${levels[id].name} in stock (only ${levels[id].on_hand}).`);
  }
  const subtotal = money(lines.reduce((a, l) => a + l.line, 0));
  const discount = money(b.discount); if (discount < 0 || discount > subtotal) bad("Discount must be between 0 and the subtotal.");
  let customerId = null, customer = str(b.customer, 60);
  if (b.customer_id) { const c = await db.get("SELECT * FROM customers WHERE id = ?", num(b.customer_id)); if (c) { customerId = c.id; customer = c.name; } }
  const sale = await db.tx(async (t) => {
    const prefix = "R" + date.slice(2).replace(/-/g, "") + "-";
    const n = (await t.get("SELECT COUNT(*) c FROM sales WHERE receipt_no LIKE ?", prefix + "%")).c + 1;
    const receipt = prefix + String(n).padStart(3, "0");
    const id = (await t.run(`INSERT INTO sales (receipt_no, date, t, user_id, customer_id, customer, referred_by, subtotal, discount, total, method, note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, receipt, date, now(), req.user.id, customerId, customer, str(b.referred_by, 60), subtotal, discount, money(subtotal - discount), method, str(b.note, 200))).lastInsertRowid;
    for (const l of lines) await t.run("INSERT INTO sale_items (sale_id, product_id, name, qty, price, cost, line_total) VALUES (?,?,?,?,?,?,?)", id, l.p.id, l.p.name, l.qty, l.price, l.cost, l.line);
    return { id, receipt };
  });
  const customs = lines.filter((l) => l.custom).map((l) => `${l.p.name} @ ${l.price}`);
  await audit(req, "sale.created", `${sale.receipt} total ${money(subtotal - discount)}${customs.length ? " — custom: " + customs.join(", ") : ""}`);
  res.json({ ok: true, sale: await getSale(sale.id, req.user) });
}));

async function getSale(id, user) {
  const s = await db.get("SELECT * FROM sales WHERE id = ?", id); if (!s) return null;
  s.items = await db.all("SELECT product_id, name, qty, price, cost, line_total FROM sale_items WHERE sale_id = ?", id);
  if (!can(user, "costs.view")) s.items.forEach((i) => delete i.cost);
  return s;
}
app.get("/api/sales", auth, need("sales.view"), wrap(async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : localDate(), to = isDate(req.query.to) ? req.query.to : from;
  const uf = num(req.query.user) ? ` AND user_id = ${num(req.query.user) | 0}` : "";
  const [sales, items] = await Promise.all([
    db.all("SELECT * FROM sales WHERE date BETWEEN ? AND ?" + uf + " ORDER BY t DESC LIMIT 2000", from, to),
    db.all(`SELECT si.* FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.date BETWEEN ? AND ?` + uf.replace("user_id", "s.user_id"), from, to),
  ]);
  const by = {}; for (const i of items) { if (!can(req.user, "costs.view")) delete i.cost; (by[i.sale_id] ||= []).push(i); }
  res.json({ sales: sales.map((s) => ({ ...s, items: by[s.id] || [] })) });
}));
app.post("/api/sales/:id/void", auth, need("sales.void"), wrap(async (req, res) => {
  const reason = str(req.body.reason, 200); if (reason.length < 3) bad("Please write the reason.");
  const s = await db.get("SELECT * FROM sales WHERE id = ?", num(req.params.id)); if (!s) bad("Sale not found.");
  if (s.voided) bad("This sale is already cancelled.");
  await db.run("UPDATE sales SET voided=1, void_by=?, void_t=?, void_reason=? WHERE id=?", req.user.id, now(), reason, s.id);
  await audit(req, "sale.voided", `${s.receipt_no}: ${reason}`); res.json({ ok: true });
}));

// ======================================================================
// Items (products)
// ======================================================================
function itemFields(b) {
  const name = str(b.name, 80); if (!name) bad("Please enter the item name.");
  const category = str(b.category, 40) || "Other", unit = str(b.unit, 20) || "Piece";
  const cost = money(b.cost), price = money(b.price), reorder = num(b.reorder);
  if (cost < 0 || price < 0 || reorder < 0) bad("Numbers cannot be negative.");
  return { name, category, unit, cost, price, reorder, sellable: b.sellable === false || b.sellable === "0" ? 0 : 1 };
}
app.post("/api/items", auth, need("items.manage"), wrap(async (req, res) => {
  const f = itemFields(req.body || {});
  if (await db.get("SELECT 1 FROM products WHERE name = ? COLLATE NOCASE AND archived = 0", f.name)) bad("An item with this name already exists.");
  const opening = num(req.body.opening); if (opening < 0) bad("Opening stock cannot be negative.");
  const id = await db.tx(async (t) => {
    const id = (await t.run("INSERT INTO products (name, category, unit, cost, price, reorder, sellable, created_t) VALUES (?,?,?,?,?,?,?,?)",
      f.name, f.category, f.unit, f.cost, f.price, f.reorder, f.sellable, now())).lastInsertRowid;
    const sku = str(req.body.sku, 30) || "GSH-" + String(id).padStart(4, "0");
    if (await t.get("SELECT 1 FROM products WHERE sku = ? AND id <> ?", sku, id)) bad("That item code (SKU) is already used.");
    await t.run("UPDATE products SET sku = ? WHERE id = ?", sku, id);
    if (opening > 0) await t.run("INSERT INTO stock_moves (date, t, product_id, type, qty, unit_cost, note, user_id) VALUES (?,?,?,?,?,?,?,?)", localDate(), now(), id, "opening", opening, f.cost, "Opening stock", req.user.id);
    return id;
  });
  await audit(req, "item.created", `${f.name} (price ${f.price}, cost ${f.cost})`); res.json({ ok: true, id });
}));
app.put("/api/items/:id", auth, need("items.manage"), wrap(async (req, res) => {
  const old = await db.get("SELECT * FROM products WHERE id = ?", num(req.params.id)); if (!old) bad("Item not found.");
  const f = itemFields(req.body || {});
  const sku = str(req.body.sku, 30) || old.sku;
  if (await db.get("SELECT 1 FROM products WHERE sku = ? AND id <> ?", sku, old.id)) bad("That item code (SKU) is already used.");
  await db.run("UPDATE products SET sku=?, name=?, category=?, unit=?, cost=?, price=?, reorder=?, sellable=? WHERE id=?", sku, f.name, f.category, f.unit, f.cost, f.price, f.reorder, f.sellable, old.id);
  const changes = ["name", "price", "cost", "category"].filter((k) => String(old[k]) !== String(f[k])).map((k) => `${k}: ${old[k]} → ${f[k]}`).join(", ");
  await audit(req, "item.updated", `${f.name}${changes ? " — " + changes : ""}`); res.json({ ok: true });
}));
app.post("/api/items/:id/archive", auth, need("items.manage"), wrap(async (req, res) => {
  const p = await db.get("SELECT * FROM products WHERE id = ?", num(req.params.id)); if (!p) bad("Item not found.");
  const val = req.body.archived ? 1 : 0;
  await db.run("UPDATE products SET archived = ? WHERE id = ?", val, p.id);
  await audit(req, val ? "item.archived" : "item.restored", p.name); res.json({ ok: true });
}));

// ======================================================================
// Inventory (stock movements)
// ======================================================================
const MOVE_TYPES = { purchase: 1, produced: 1, returned: 1, used: -1, damaged: -1, expired: -1, gift: -1, count: 0 };
app.get("/api/stock", auth, need("stock.view"), wrap(async (req, res) => {
  const upto = isDate(req.query.date) ? req.query.date : null;
  res.json({ items: (await stockLevels(upto)).map((p) => productOut(p, req.user)) });
}));
app.get("/api/moves", auth, need("stock.view"), wrap(async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : "0000-01-01", to = isDate(req.query.to) ? req.query.to : "9999-12-31";
  const pid = num(req.query.product_id);
  const rows = await db.all(`SELECT m.*, p.name, p.unit FROM stock_moves m JOIN products p ON p.id = m.product_id
    WHERE m.date BETWEEN ? AND ? ${pid ? "AND m.product_id = ?" : ""} ${num(req.query.user) ? "AND m.user_id = " + (num(req.query.user) | 0) : ""} ORDER BY m.date DESC, m.t DESC LIMIT 2000`, ...(pid ? [from, to, pid] : [from, to]));
  if (!can(req.user, "costs.view")) rows.forEach((r) => delete r.unit_cost);
  res.json({ moves: rows });
}));
app.post("/api/moves", auth, wrap(async (req, res) => {
  const b = req.body || {}, type = String(b.type || "");
  if (!(type in MOVE_TYPES)) bad("Choose the type of stock change.");
  const perm = type === "count" ? "stock.count" : MOVE_TYPES[type] > 0 ? "stock.in" : "stock.loss";
  if (!can(req.user, perm)) return res.status(403).json({ error: "You don't have permission to do this." });
  const p = (await stockLevels()).find((x) => x.id === num(b.product_id)); if (!p || p.archived) bad("Choose an item.");
  const date = isDate(b.date) ? b.date : localDate();
  let qty = num(b.qty);
  if (type === "count") { if (qty < 0) bad("Counted quantity cannot be negative."); qty = qty - p.on_hand; if (qty === 0) bad("The count matches the system. Nothing to change."); }
  else { if (qty <= 0) bad("Quantity must be more than 0."); qty = qty * MOVE_TYPES[type]; }
  // Losses and counts are valued at the item's cost price; stock coming in may have its own cost.
  const unitCost = MOVE_TYPES[type] <= 0 || b.unit_cost === "" || b.unit_cost == null ? p.cost : money(b.unit_cost);
  if (unitCost < 0) bad("Cost cannot be negative.");
  await db.run("INSERT INTO stock_moves (date, t, product_id, type, qty, unit_cost, supplier, ref, note, user_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
    date, now(), p.id, type, qty, unitCost, str(b.supplier, 60), str(b.ref, 40), str(b.note, 200), req.user.id);
  if (type === "purchase" && b.update_cost && can(req.user, "items.manage") && unitCost !== p.cost) await db.run("UPDATE products SET cost = ? WHERE id = ?", unitCost, p.id);
  await audit(req, "stock." + type, `${p.name} ${qty > 0 ? "+" : ""}${qty}`); res.json({ ok: true });
}));
app.post("/api/moves/:id/void", auth, need("stock.void"), wrap(async (req, res) => {
  const reason = str(req.body.reason, 200); if (reason.length < 3) bad("Please write the reason.");
  const m = await db.get("SELECT m.*, p.name FROM stock_moves m JOIN products p ON p.id=m.product_id WHERE m.id = ?", num(req.params.id)); if (!m) bad("Not found.");
  if (m.voided) bad("Already cancelled.");
  await db.run("UPDATE stock_moves SET voided=1, void_by=?, void_t=?, void_reason=? WHERE id=?", req.user.id, now(), reason, m.id);
  await audit(req, "stock.voided", `${m.name} ${m.type} ${m.qty}: ${reason}`); res.json({ ok: true });
}));

// ======================================================================
// Expenses
// ======================================================================
app.get("/api/expenses", auth, need("expense.view"), wrap(async (req, res) => {
  const from = isDate(req.query.from) ? req.query.from : localDate(), to = isDate(req.query.to) ? req.query.to : from;
  const uf = num(req.query.user) ? ` AND user_id = ${num(req.query.user) | 0}` : "";
  res.json({ expenses: await db.all("SELECT * FROM expenses WHERE date BETWEEN ? AND ?" + uf + " ORDER BY date DESC, t DESC LIMIT 2000", from, to) });
}));
app.post("/api/expenses", auth, need("expense.add"), wrap(async (req, res) => {
  const b = req.body || {}, s = await settings();
  const category = list(s.expense_categories).includes(b.category) ? b.category : bad("Choose the type of expense.");
  const amount = money(b.amount); if (amount <= 0 || amount > 1e10) bad("Enter the amount.");
  const date = isDate(b.date) ? b.date : localDate();
  await db.run("INSERT INTO expenses (date, t, category, description, amount, method, note, user_id) VALUES (?,?,?,?,?,?,?,?)",
    date, now(), category, str(b.description, 120), amount, str(b.method, 30), str(b.note, 200), req.user.id);
  await audit(req, "expense.created", `${category} ${amount}`); res.json({ ok: true });
}));
app.post("/api/expenses/:id/void", auth, need("expense.void"), wrap(async (req, res) => {
  const reason = str(req.body.reason, 200); if (reason.length < 3) bad("Please write the reason.");
  const e = await db.get("SELECT * FROM expenses WHERE id = ?", num(req.params.id)); if (!e) bad("Not found."); if (e.voided) bad("Already cancelled.");
  await db.run("UPDATE expenses SET voided=1, void_by=?, void_t=?, void_reason=? WHERE id=?", req.user.id, now(), reason, e.id);
  await audit(req, "expense.voided", `${e.category} ${e.amount}: ${reason}`); res.json({ ok: true });
}));

// ======================================================================
// Customers
// ======================================================================
app.get("/api/customers", auth, need("customers"), wrap(async (req, res) => {
  res.json({ customers: await db.all(`SELECT c.*, COUNT(s.id) visits, COALESCE(SUM(s.total),0) spent, MAX(s.date) last_visit
    FROM customers c LEFT JOIN sales s ON s.customer_id = c.id AND s.voided = 0 GROUP BY c.id ORDER BY spent DESC, c.name`) });
}));
app.post("/api/customers", auth, need("customers"), wrap(async (req, res) => {
  const name = str(req.body.name, 60); if (!name) bad("Enter the customer's name.");
  const id = num(req.params.id || req.body.id);
  if (id) { await db.run("UPDATE customers SET name=?, phone=?, note=? WHERE id=?", name, str(req.body.phone, 30), str(req.body.note, 200), id); await audit(req, "customer.updated", name); return res.json({ ok: true, id }); }
  const nid = (await db.run("INSERT INTO customers (name, phone, note, created_t) VALUES (?,?,?,?)", name, str(req.body.phone, 30), str(req.body.note, 200), now())).lastInsertRowid;
  await audit(req, "customer.created", name); res.json({ ok: true, id: nid });
}));

// ======================================================================
// Day book
// ======================================================================
app.get("/api/daybook", auth, need("daybook"), wrap(async (req, res) => {
  const d = isDate(req.query.date) ? req.query.date : localDate();
  const [sales, items, moves, levels, expenses] = await Promise.all([
    db.all("SELECT * FROM sales WHERE date = ? ORDER BY t", d),
    db.all("SELECT si.* FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.date = ?", d),
    db.all("SELECT m.*, p.name, p.unit FROM stock_moves m JOIN products p ON p.id=m.product_id WHERE m.date = ? ORDER BY m.t", d),
    stockLevels(d),
    db.all("SELECT * FROM expenses WHERE date = ? ORDER BY t", d),
  ]);
  const by = {}; for (const i of items) { if (!can(req.user, "costs.view")) delete i.cost; (by[i.sale_id] ||= []).push(i); }
  if (!can(req.user, "costs.view")) moves.forEach((m) => delete m.unit_cost);
  const closing = levels.filter((p) => !p.archived).map((p) => productOut(p, req.user));
  const soldQty = {}; for (const s of sales) if (!s.voided) for (const i of by[s.id] || []) soldQty[i.product_id] = (soldQty[i.product_id] || 0) + i.qty;
  const inQty = {}, outQty = {}; for (const m of moves) if (!m.voided && m.type !== "opening") (m.qty > 0 ? inQty : outQty)[m.product_id] = ((m.qty > 0 ? inQty : outQty)[m.product_id] || 0) + Math.abs(m.qty);
  res.json({ date: d, sales: sales.map((s) => ({ ...s, items: by[s.id] || [] })), moves, expenses,
    closing: closing.map((p) => ({ ...p, sold: soldQty[p.id] || 0, came_in: inQty[p.id] || 0, other_out: outQty[p.id] || 0 })) });
}));

// ======================================================================
// Reports (managers and admins)
// ======================================================================
async function report(from, to) {
  const q = (sql) => db.all(sql, from, to);
  const one = async (sql) => (await db.get(sql, from, to)).v || 0;
  const [sales, discounts, receipts, cogs, expenses, losses, purchases, by_day, exp_by_day, by_item, by_category, by_method, by_staff, exp_by_category, voided] = await Promise.all([
    one("SELECT SUM(total) v FROM sales WHERE voided=0 AND date BETWEEN ? AND ?"),
    one("SELECT SUM(discount) v FROM sales WHERE voided=0 AND date BETWEEN ? AND ?"),
    one("SELECT COUNT(*) v FROM sales WHERE voided=0 AND date BETWEEN ? AND ?"),
    one("SELECT SUM(si.qty*si.cost) v FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.voided=0 AND s.date BETWEEN ? AND ?"),
    one("SELECT SUM(amount) v FROM expenses WHERE voided=0 AND date BETWEEN ? AND ?"),
    one("SELECT SUM(-qty*unit_cost) v FROM stock_moves WHERE voided=0 AND type IN ('damaged','expired','gift') AND date BETWEEN ? AND ?"),
    one("SELECT SUM(qty*unit_cost) v FROM stock_moves WHERE voided=0 AND type='purchase' AND date BETWEEN ? AND ?"),
    q("SELECT date, SUM(total) v, COUNT(*) n FROM sales WHERE voided=0 AND date BETWEEN ? AND ? GROUP BY date ORDER BY date"),
    q("SELECT date, SUM(amount) v FROM expenses WHERE voided=0 AND date BETWEEN ? AND ? GROUP BY date"),
    q(`SELECT si.name, SUM(si.qty) qty, SUM(si.line_total) v, SUM(si.qty*si.cost) cost FROM sale_items si JOIN sales s ON s.id=si.sale_id
      WHERE s.voided=0 AND s.date BETWEEN ? AND ? GROUP BY COALESCE(si.product_id, 'c:' || si.name) ORDER BY v DESC`),
    q(`SELECT COALESCE(p.category, 'Custom items') name, SUM(si.line_total) v FROM sale_items si JOIN sales s ON s.id=si.sale_id LEFT JOIN products p ON p.id=si.product_id
      WHERE s.voided=0 AND s.date BETWEEN ? AND ? GROUP BY 1 ORDER BY v DESC`),
    q("SELECT method name, SUM(total) v, COUNT(*) n FROM sales WHERE voided=0 AND date BETWEEN ? AND ? GROUP BY method ORDER BY v DESC"),
    q(`SELECT COALESCE(u.name,'(imported)') name, SUM(s.total) v, COUNT(*) n FROM sales s LEFT JOIN users u ON u.id=s.user_id
      WHERE s.voided=0 AND s.date BETWEEN ? AND ? GROUP BY s.user_id ORDER BY v DESC`),
    q("SELECT category name, SUM(amount) v FROM expenses WHERE voided=0 AND date BETWEEN ? AND ? GROUP BY category ORDER BY v DESC"),
    one("SELECT COUNT(*) v FROM sales WHERE voided=1 AND date BETWEEN ? AND ?"),
  ]);
  return {
    from, to, sales, discounts, receipts, cogs, gross: sales - cogs, expenses, losses, net: sales - cogs - expenses - losses, purchases,
    avg_receipt: receipts ? sales / receipts : 0,
    by_day, exp_by_day, by_item, by_category, by_method, by_staff, exp_by_category, voided,
  };
}
app.get("/api/reports", auth, need("reports"), wrap(async (req, res) => {
  const to = isDate(req.query.to) ? req.query.to : localDate(), from = isDate(req.query.from) ? req.query.from : to.slice(0, 8) + "01";
  res.json(await report(from, to));
}));

// ======================================================================
// Excel export
// ======================================================================
app.get("/api/export.xlsx", auth, need("export"), wrap(async (req, res) => {
  const to = isDate(req.query.to) ? req.query.to : localDate(), from = isDate(req.query.from) ? req.query.from : "2000-01-01";
  const [s, names, R, levels, sales, saleLines, moves, expenses] = await Promise.all([
    settings(), userNames(), report(from, to), stockLevels(),
    db.all("SELECT * FROM sales WHERE date BETWEEN ? AND ? ORDER BY t", from, to),
    db.all("SELECT s.receipt_no, s.date, si.* FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.voided=0 AND s.date BETWEEN ? AND ? ORDER BY s.t", from, to),
    db.all("SELECT m.*, p.name FROM stock_moves m JOIN products p ON p.id=m.product_id WHERE m.date BETWEEN ? AND ? ORDER BY m.t", from, to),
    db.all("SELECT * FROM expenses WHERE date BETWEEN ? AND ? ORDER BY t", from, to),
  ]);
  const wb = new ExcelJS.Workbook(); wb.creator = s.shop_name;
  const M = "#,##0", time = timeHM;
  const sheet = (title, cols, rows) => {
    const ws = wb.addWorksheet(title);
    ws.columns = cols.map(([header, key, width, fmt]) => ({ header, key, width: width || 14, style: fmt ? { numFmt: fmt } : {} }));
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0E7C7B" } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    rows.forEach((r) => ws.addRow(r)); return ws;
  };
  sheet("Summary", [["Item", "k", 34], ["Amount (RWF)", "v", 18, M]], [
    { k: `Period`, v: `${from} to ${to}` }, { k: "Sales (money received)", v: R.sales }, { k: "Discounts given", v: R.discounts }, { k: "Receipts", v: R.receipts },
    { k: "Cost of items sold", v: R.cogs }, { k: "Gross profit", v: R.gross }, { k: "Expenses", v: R.expenses }, { k: "Losses (damaged, expired, gifts)", v: R.losses },
    { k: "NET PROFIT", v: R.net }, { k: "Stock purchases (cash out, for info)", v: R.purchases }]);
  sheet("Stock", [["Code", "sku", 12], ["Item", "name", 30], ["Category", "category", 18], ["Unit", "unit", 10], ["On hand", "on_hand", 10], ["Reorder at", "reorder", 10], ["Cost", "cost", 12, M], ["Price", "price", 12, M], ["Stock value", "val", 14, M]],
    levels.filter((p) => !p.archived).map((p) => ({ ...p, val: Math.max(p.on_hand, 0) * p.cost })));
  sheet("Receipts", [["Receipt", "receipt_no", 14], ["Date", "date", 12], ["Time", "time", 8], ["Customer", "customer", 20], ["Subtotal", "subtotal", 12, M], ["Discount", "discount", 10, M], ["Total", "total", 12, M], ["Paid by", "method", 14], ["Cashier", "who", 18], ["Status", "st", 12], ["Cancel reason", "void_reason", 24]],
    sales.map((x) => ({ ...x, time: time(x.t), who: names[x.user_id] || "", st: x.voided ? "CANCELLED" : "OK" })));
  sheet("Sale lines", [["Receipt", "receipt_no", 14], ["Date", "date", 12], ["Item", "name", 28], ["Qty", "qty", 8], ["Price", "price", 12, M], ["Line total", "line_total", 12, M], ["Cost each", "cost", 12, M]], saleLines);
  sheet("Stock movements", [["Date", "date", 12], ["Item", "name", 28], ["Type", "type", 12], ["Qty", "qty", 8], ["Unit cost", "unit_cost", 12, M], ["Supplier", "supplier", 18], ["Ref", "ref", 12], ["Note", "note", 24], ["By", "who", 16], ["Status", "st", 12]],
    moves.map((m) => ({ ...m, who: names[m.user_id] || "", st: m.voided ? "CANCELLED" : "OK" })));
  sheet("Expenses", [["Date", "date", 12], ["Type", "category", 18], ["Description", "description", 30], ["Amount", "amount", 14, M], ["Paid by", "method", 14], ["Note", "note", 24], ["By", "who", 16], ["Status", "st", 12]],
    expenses.map((e) => ({ ...e, who: names[e.user_id] || "", st: e.voided ? "CANCELLED" : "OK" })));
  await audit(req, "export.excel", `${from} to ${to}`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="Grathia_${from}_to_${to}.xlsx"`);
  await wb.xlsx.write(res); res.end();
}));

// ======================================================================
// Administration: users, audit log, settings, backup
// ======================================================================
app.get("/api/users", auth, need("users"), wrap(async (req, res) => {
  const [sess, users] = await Promise.all([
    db.all("SELECT user_id, COUNT(*) n, MAX(last_seen_t) seen FROM sessions GROUP BY user_id"),
    db.all("SELECT id, name, username, phone, role, status, must_change, created_t, last_login_t FROM users ORDER BY status = 'pending' DESC, name"),
  ]);
  const active = Object.fromEntries(sess.map((r) => [r.user_id, r]));
  res.json({ users: users.map((u) => ({ ...u, sessions: active[u.id]?.n || 0, last_seen_t: active[u.id]?.seen || null })) });
}));
// Administrator creates an account directly (active at once; must change the temporary password at first login).
app.post("/api/users", auth, need("users"), wrap(async (req, res) => {
  const b = req.body || {}, name = str(b.name, 60), username = str(b.username, 30).toLowerCase(), phone = str(b.phone, 30);
  const role = ["admin", "manager", "cashier"].includes(b.role) ? b.role : bad("Choose a role.");
  if (!name) bad("Enter the person's full name.");
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) bad("Username must have no spaces — for example: eric or eric.m (letters, numbers, dots or dashes).");
  const p = passwordProblem(b.password, username); if (p) bad(p);
  if (await db.get("SELECT 1 FROM users WHERE username = ?", username)) bad("That username is taken. Choose another.");
  const salt = crypto.randomBytes(16).toString("hex"), mustChange = b.must_change === false ? 0 : 1;
  await db.run("INSERT INTO users (name, username, phone, pass_hash, salt, role, status, must_change, created_t) VALUES (?,?,?,?,?,?,?,?,?)",
    name, username, phone, hashPw(b.password, salt), salt, role, "active", mustChange, now());
  await audit(req, "user.created", `${username} as ${role}${mustChange ? " (must change password)" : ""}`);
  res.json({ ok: true });
}));

app.post("/api/users/:id", auth, need("users"), wrap(async (req, res) => {
  const u = await db.get("SELECT * FROM users WHERE id = ?", num(req.params.id)); if (!u) bad("User not found.");
  if (u.id === req.user.id) bad("You can't change your own account here.");
  const { status, role } = req.body || {};
  if (status && !["active", "disabled"].includes(status)) bad("Unknown status.");
  if (role && !["admin", "manager", "cashier"].includes(role)) bad("Unknown role.");
  if ((status === "disabled" || (role && role !== "admin")) && u.role === "admin") {
    const admins = (await db.get("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='active' AND id <> ?", u.id)).c;
    if (!admins) bad("There must always be at least one active administrator.");
  }
  if (status) await db.run("UPDATE users SET status = ? WHERE id = ?", status, u.id);
  if (role) await db.run("UPDATE users SET role = ? WHERE id = ?", role, u.id);
  if (status === "disabled" || role) await db.run("DELETE FROM sessions WHERE user_id = ?", u.id); // force fresh login with new rights
  await audit(req, "user.changed", `${u.username}${status ? " status→" + status : ""}${role ? " role→" + role : ""}`);
  res.json({ ok: true });
}));
app.post("/api/users/:id/reset-password", auth, need("users"), wrap(async (req, res) => {
  const u = await db.get("SELECT * FROM users WHERE id = ?", num(req.params.id)); if (!u) bad("User not found.");
  const p = passwordProblem(req.body.password, u.username); if (p) bad(p);
  const salt = crypto.randomBytes(16).toString("hex");
  await db.run("UPDATE users SET pass_hash = ?, salt = ?, must_change = 1 WHERE id = ?", hashPw(req.body.password, salt), salt, u.id);
  await db.run("DELETE FROM sessions WHERE user_id = ?", u.id);
  await clearFails("u:" + u.username);
  await audit(req, "user.password_reset", u.username); res.json({ ok: true });
}));
app.post("/api/users/:id/logout", auth, need("users"), wrap(async (req, res) => {
  const u = await db.get("SELECT username FROM users WHERE id = ?", num(req.params.id)); if (!u) bad("User not found.");
  await db.run("DELETE FROM sessions WHERE user_id = ?", num(req.params.id));
  await audit(req, "user.sessions_ended", u.username); res.json({ ok: true });
}));

app.get("/api/audit", auth, need("audit"), wrap(async (req, res) => {
  const limit = Math.min(500, Math.max(1, num(req.query.limit) || 200)), before = num(req.query.before) || 9e15;
  const action = str(req.query.action, 40);
  const from = isDate(req.query.from) ? dayStart(req.query.from) : 0, to = isDate(req.query.to) ? dayEnd(req.query.to) : 9e15;
  const rows = await db.all(`SELECT a.*, u.name, u.username FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.t < ? AND a.t BETWEEN ? AND ? ${action ? "AND a.action LIKE ?" : ""} ORDER BY a.t DESC LIMIT ?`,
    ...(action ? [before, from, to, action + "%", limit] : [before, from, to, limit]));
  res.json({ rows });
}));

const SETTING_KEYS = ["shop_name", "shop_tagline", "shop_address", "shop_phone", "receipt_footer", "idle_minutes", "allow_negative_stock", "allow_custom_items", "auto_backup_keep", "expense_categories", "payment_methods", "categories"];
app.get("/api/settings", auth, need("settings"), wrap(async (req, res) => { const s = await settings(); res.json(Object.fromEntries(SETTING_KEYS.map((k) => [k, s[k]]))); }));
app.put("/api/settings", auth, need("settings"), wrap(async (req, res) => {
  const b = req.body || {}, updates = [], changed = [];
  for (const k of SETTING_KEYS) if (k in b) {
    let v = str(b[k], 600);
    if (k === "idle_minutes") { const m = Math.round(num(v)); if (m < 5 || m > 720) bad("Auto log-out must be between 5 and 720 minutes."); v = String(m); }
    if (k === "allow_negative_stock" || k === "allow_custom_items") v = v === "1" || v === "true" ? "1" : "0";
    if (k === "auto_backup_keep") { const m = Math.round(num(v)); if (m < 3 || m > 365) bad("Keep between 3 and 365 automatic backups."); v = String(m); }
    if (["expense_categories", "payment_methods", "categories"].includes(k)) { v = list(v).join(","); if (!v) bad("Lists cannot be empty."); }
    updates.push([v, k]); changed.push(k);
  }
  await db.tx(async (t) => { for (const [v, k] of updates) await t.run("UPDATE settings SET value = ? WHERE key = ?", v, k); });
  await audit(req, "settings.changed", changed.join(", ")); res.json({ ok: true });
}));

// ---------- automatic daily backups (data/backups, newest N kept) ----------
// Only for the local database file. Online (Turso) keeps its own automatic backups.
const BACKUP_DIR = path.join(DATA_DIR, "backups");
async function autoBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `grathia-${localDate()}.db`);
    if (!fs.existsSync(file)) { await backupToFile(file); console.log(`  Automatic backup saved: ${file}`); }
    const keep = Math.max(3, num((await settings()).auto_backup_keep) || 30);
    const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^grathia-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  } catch (e) { console.error("  Automatic backup failed:", e.message); }
}
app.get("/api/backup/info", auth, need("backup"), (req, res) => {
  if (isRemote) return res.json({ online: true, count: 0, latest: null, files: [] });
  let files = []; try { files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db")).sort().reverse(); } catch {}
  res.json({ folder: BACKUP_DIR, count: files.length, latest: files[0] || null, files: files.slice(0, 10) });
});

app.get("/api/backup", auth, need("backup"), wrap(async (req, res) => {
  const file = await backupToFile();
  await audit(req, "backup.downloaded");
  res.download(file, `grathia-backup-${localDate()}.db`, () => fs.unlink(file, () => {}));
}));

// ======================================================================
// Errors and start-up
// ======================================================================
// Excel + PDF downloads for every section (see exports.js)
require("./exports")(app, { db, stockLevels, report, can, settings, userNames, localDate, timeHM, dayStart, dayEnd, isDate, auth, audit, num });

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));
app.use((err, req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === "entity.parse.failed" || err.type === "entity.too.large") return res.status(400).json({ error: "Bad request." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server. Please try again." });
});

// On Vercel the app is imported (not started); on your own computer it listens on a port.
if (require.main === module) {
  if (!isRemote) ready.then(() => { autoBackup(); setInterval(autoBackup, 3600e3).unref(); });
  app.listen(PORT, HOST, () => {
    const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
    console.log(`\n  Grathia Shop Manager is running.\n`);
    console.log(`  On this computer:        http://localhost:${PORT}`);
    for (const ip of ips) console.log(`  On phones (same Wi-Fi):  http://${ip}:${PORT}`);
    console.log(`\n  Press Ctrl + C to stop.\n`);
  });
}
module.exports = app;
