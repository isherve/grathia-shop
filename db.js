// Database: libSQL / Turso.
//  - On Vercel (or anywhere online): set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.
//  - On your own computer with no settings: uses the file ./data/grathia.db.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createClient } = require("@libsql/client");

let url = process.env.TURSO_DATABASE_URL;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
if (!url) {
  if (process.env.VERCEL) throw new Error("TURSO_DATABASE_URL is not set. Add it in Vercel → Project → Settings → Environment Variables.");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  url = "file:" + path.join(DATA_DIR, "grathia.db").replace(/\\/g, "/");
}
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });

// Small helper API used by the server: db.get / db.all / db.run, all async.
const clean = (args) => args.map((a) => (a === undefined ? null : a));
const toRows = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
function api(exec) {
  return {
    all: async (sql, ...args) => toRows(await exec({ sql, args: clean(args) })),
    get: async (sql, ...args) => toRows(await exec({ sql, args: clean(args) }))[0],
    run: async (sql, ...args) => {
      const rs = await exec({ sql, args: clean(args) });
      return { changes: rs.rowsAffected, lastInsertRowid: rs.lastInsertRowid == null ? null : Number(rs.lastInsertRowid) };
    },
  };
}
const db = api((stmt) => client.execute(stmt));

// Run fn(t) inside one write transaction; t has the same get/all/run methods.
db.tx = async (fn) => {
  const t = await client.transaction("write");
  try { const r = await fn(api((stmt) => t.execute(stmt))); await t.commit(); return r; }
  catch (e) { await t.rollback().catch(() => {}); throw e; }
  finally { t.close(); }
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  username     TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone        TEXT DEFAULT '',
  pass_hash    TEXT NOT NULL,
  salt         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'cashier',   -- admin | manager | cashier
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | active | disabled
  must_change  INTEGER NOT NULL DEFAULT 0,        -- 1 = must set a new password at next login
  created_t    INTEGER NOT NULL,
  last_login_t INTEGER
);

-- Only a SHA-256 hash of each session token is stored, never the token itself.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_t   INTEGER NOT NULL,
  last_seen_t INTEGER NOT NULL,
  ip          TEXT,
  agent       TEXT
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS products (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  sku       TEXT UNIQUE,
  name      TEXT NOT NULL,
  category  TEXT NOT NULL DEFAULT 'Other',
  unit      TEXT NOT NULL DEFAULT 'Piece',
  cost      REAL NOT NULL DEFAULT 0,
  price     REAL NOT NULL DEFAULT 0,
  reorder   REAL NOT NULL DEFAULT 0,
  sellable  INTEGER NOT NULL DEFAULT 1,      -- 0 = ingredient / used in kitchen only
  archived  INTEGER NOT NULL DEFAULT 0,
  created_t INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  phone     TEXT DEFAULT '',
  note      TEXT DEFAULT '',
  created_t INTEGER NOT NULL
);

-- A sale = one receipt with one or more lines.
CREATE TABLE IF NOT EXISTS sales (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_no  TEXT NOT NULL UNIQUE,
  date        TEXT NOT NULL,
  t           INTEGER NOT NULL,
  user_id     INTEGER REFERENCES users(id),
  customer_id INTEGER REFERENCES customers(id),
  customer    TEXT DEFAULT '',
  referred_by TEXT DEFAULT '',
  subtotal    REAL NOT NULL,
  discount    REAL NOT NULL DEFAULT 0,
  total       REAL NOT NULL,
  method      TEXT NOT NULL,
  note        TEXT DEFAULT '',
  voided      INTEGER NOT NULL DEFAULT 0,
  void_by     INTEGER,
  void_t      INTEGER,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS sales_date ON sales(date);

CREATE TABLE IF NOT EXISTS sale_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id    INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),     -- NULL = custom item typed at the till
  name       TEXT NOT NULL,
  qty        REAL NOT NULL,
  price      REAL NOT NULL,
  cost       REAL NOT NULL,
  line_total REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS sale_items_sale ON sale_items(sale_id);

-- Every stock change that is not a sale. qty is signed: + adds stock, - removes it.
-- type: opening | purchase | produced | returned | used | damaged | expired | gift | count
CREATE TABLE IF NOT EXISTS stock_moves (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  t          INTEGER NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id),
  type       TEXT NOT NULL,
  qty        REAL NOT NULL,
  unit_cost  REAL NOT NULL DEFAULT 0,
  supplier   TEXT DEFAULT '',
  ref        TEXT DEFAULT '',
  note       TEXT DEFAULT '',
  user_id    INTEGER REFERENCES users(id),
  voided     INTEGER NOT NULL DEFAULT 0,
  void_by    INTEGER,
  void_t     INTEGER,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS moves_date ON stock_moves(date);
CREATE INDEX IF NOT EXISTS moves_product ON stock_moves(product_id);

CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,
  t           INTEGER NOT NULL,
  category    TEXT NOT NULL,
  description TEXT DEFAULT '',
  amount      REAL NOT NULL,
  method      TEXT DEFAULT '',
  note        TEXT DEFAULT '',
  user_id     INTEGER REFERENCES users(id),
  voided      INTEGER NOT NULL DEFAULT 0,
  void_by     INTEGER,
  void_t      INTEGER,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS expenses_date ON expenses(date);

-- Who did what, when, from where. Never edited or deleted by the app.
CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  t       INTEGER NOT NULL,
  user_id INTEGER,
  action  TEXT NOT NULL,
  detail  TEXT DEFAULT '',
  ip      TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_t ON audit(t);

-- Failed log-in counters (kept in the database so every server instance sees them).
CREATE TABLE IF NOT EXISTS login_fails (
  key   TEXT PRIMARY KEY,
  n     INTEGER NOT NULL DEFAULT 0,
  until INTEGER NOT NULL DEFAULT 0
);

-- Every amount of money received (or refunded, negative), by method and day.
-- kind: sale (paid at the till) | repayment (customer paying a debt) | deposit (on an order) | refund
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,
  t           INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  method      TEXT NOT NULL,
  amount      REAL NOT NULL,
  sale_id     INTEGER REFERENCES sales(id),
  order_id    INTEGER REFERENCES orders(id),
  customer_id INTEGER REFERENCES customers(id),
  note        TEXT DEFAULT '',
  user_id     INTEGER REFERENCES users(id),
  voided      INTEGER NOT NULL DEFAULT 0,
  void_by     INTEGER,
  void_t      INTEGER,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS payments_date ON payments(date);
CREATE INDEX IF NOT EXISTS payments_sale ON payments(sale_id);
CREATE INDEX IF NOT EXISTS payments_order ON payments(order_id);

-- Customer orders (e.g. cakes) taken in advance, usually with a deposit.
-- status: open | ready | collected | cancelled
CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no     TEXT UNIQUE,
  t            INTEGER NOT NULL,
  date         TEXT NOT NULL,
  customer_id  INTEGER REFERENCES customers(id),
  customer     TEXT NOT NULL,
  phone        TEXT DEFAULT '',
  description  TEXT NOT NULL,
  pickup_date  TEXT NOT NULL,
  pickup_time  TEXT DEFAULT '',
  total        REAL NOT NULL,
  cost         REAL NOT NULL DEFAULT 0,
  note         TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',
  sale_id      INTEGER REFERENCES sales(id),
  user_id      INTEGER REFERENCES users(id),
  done_t       INTEGER,
  done_by      INTEGER,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS orders_pickup ON orders(pickup_date);

-- End-of-day cash count: what the system expected per payment method vs what was counted.
CREATE TABLE IF NOT EXISTS day_closings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  t          INTEGER NOT NULL,
  user_id    INTEGER REFERENCES users(id),
  float      REAL NOT NULL DEFAULT 0,
  lines      TEXT NOT NULL,          -- JSON: [{method, expected, counted}]
  expected   REAL NOT NULL,
  counted    REAL NOT NULL,
  difference REAL NOT NULL,
  note       TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS closings_date ON day_closings(date);
`;

const DEFAULT_SETTINGS = {
  shop_name: "Grathia Sweet Haven",
  shop_tagline: "Bakery & Fresh Juice",
  shop_address: "Kicukiro, Kigali, Rwanda",
  shop_phone: "+250 784 004 546 / +250 726 163 110",
  receipt_footer: "Thank you! Every celebration deserves something sweet.",
  currency: "RWF",
  idle_minutes: "30",
  allow_negative_stock: "1",
  allow_custom_items: "1",
  allow_signup: "0",
  auto_backup_keep: "30",
  expense_categories: "Rent,Salaries & wages,Electricity,Water,Gas / charcoal,Transport,Packaging,Marketing,Airtime & internet,Repairs,Taxes & fees,Other",
  payment_methods: "Cash,MTN MoMo,Airtel Money,Bank card,Bank transfer",
  categories: "Fresh Juice,Birthday Cakes,Wedding Cakes,Graduation Cakes,Cupcakes & Pastries,Snacks,Baking Supplies,Ingredients",
};

async function init() {
  await client.executeMultiple(SCHEMA);
  // Upgrade older databases: allow custom (unlisted) items on sale lines.
  const col = (await db.all("PRAGMA table_info(sale_items)")).find((c) => c.name === "product_id");
  if (col && col.notnull) {
    await client.executeMultiple(`PRAGMA foreign_keys = OFF; BEGIN;
      CREATE TABLE sale_items_new (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id), name TEXT NOT NULL, qty REAL NOT NULL, price REAL NOT NULL, cost REAL NOT NULL, line_total REAL NOT NULL);
      INSERT INTO sale_items_new (id, sale_id, product_id, name, qty, price, cost, line_total) SELECT id, sale_id, product_id, name, qty, price, cost, line_total FROM sale_items;
      DROP TABLE sale_items; ALTER TABLE sale_items_new RENAME TO sale_items;
      CREATE INDEX IF NOT EXISTS sale_items_sale ON sale_items(sale_id);
      COMMIT; PRAGMA foreign_keys = ON;`);
    console.log("  Database upgraded (custom sale items).");
  }
  await client.batch(Object.entries(DEFAULT_SETTINGS).map(([k, v]) => ({ sql: "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", args: [k, v] })), "write");
  // Upgrade older databases: every sale made before payments were tracked was paid in full by its method.
  await db.tx(async (t) => {
    if (await t.get("SELECT value FROM settings WHERE key = 'payments_migrated'")) return;
    await t.run(`INSERT INTO payments (date, t, kind, method, amount, sale_id, customer_id, user_id, voided)
      SELECT s.date, s.t, 'sale', s.method, s.total, s.id, s.customer_id, s.user_id, s.voided FROM sales s
      WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.sale_id = s.id)`);
    await t.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('payments_migrated', '1')");
  });
  // One time: remove the sample data older versions created on first start (sale R261123-001 "Imported from Excel"
  // and the 4 starter items). Items are only removed if nothing else (sales, stock changes, orders) uses them.
  await db.tx(async (t) => {
    if (await t.get("SELECT value FROM settings WHERE key = 'sample_removed'")) return;
    const sale = await t.get("SELECT id FROM sales WHERE receipt_no = 'R261123-001' AND note = 'Imported from Excel' AND user_id IS NULL");
    if (sale) for (const q of ["DELETE FROM payments WHERE sale_id = ?", "DELETE FROM sale_items WHERE sale_id = ?", "DELETE FROM sales WHERE id = ?"]) await t.run(q, sale.id);
    const SAMPLE_MOVE = "type = 'opening' AND note = 'Opening stock' AND user_id IS NULL AND date = '2026-11-23'";
    const SAMPLE = [["GSH-0001", "Birthday cake medium"], ["GSH-0002", "Special mandazi"], ["GSH-0003", "Fresh juice (small)"], ["GSH-0004", "Fresh juice (large)"]];
    for (const [sku, name] of SAMPLE) {
      const p = await t.get("SELECT id FROM products WHERE sku = ? AND name = ?", sku, name); if (!p) continue;
      const used = await t.get(`SELECT (SELECT COUNT(*) FROM sale_items WHERE product_id = ?) + (SELECT COUNT(*) FROM stock_moves WHERE product_id = ? AND NOT (${SAMPLE_MOVE})) n`, p.id, p.id);
      if (used.n) continue; // the shop really uses this item: keep it and its opening stock
      await t.run(`DELETE FROM stock_moves WHERE product_id = ? AND ${SAMPLE_MOVE}`, p.id);
      await t.run("DELETE FROM products WHERE id = ?", p.id);
    }
    await t.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('sample_removed', '1')");
  });
}
const ready = init();
ready.catch((e) => console.error("Database start-up failed:", e));

// Copy the whole database into a new SQLite file (works for Turso and local). Returns the file path.
async function backupToFile(file = path.join(os.tmpdir(), `grathia-backup-${Date.now()}.db`)) {
  const out = createClient({ url: "file:" + file.replace(/\\/g, "/") });
  try {
    const objs = (await db.all("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' AND name NOT LIKE '!_%' ESCAPE '!' ORDER BY type = 'index'"));
    // Tables refer to each other (e.g. payments → orders), so create everything first and copy rows without link checks.
    await out.execute("PRAGMA foreign_keys = OFF");
    for (const o of objs) await out.execute(o.sql);
    for (const o of objs) {
      if (o.type !== "table") continue;
      const rows = await client.execute(`SELECT * FROM "${o.name}"`);
      const cols = rows.columns.map((c) => `"${c}"`).join(","), qs = rows.columns.map(() => "?").join(",");
      for (let i = 0; i < rows.rows.length; i += 500) {
        await out.batch(rows.rows.slice(i, i + 500).map((r) => ({ sql: `INSERT INTO "${o.name}" (${cols}) VALUES (${qs})`, args: Array.from(r) })), "write");
      }
    }
  } finally { out.close(); }
  return file;
}

// true when the data is in an online database (Turso), false for the local file.
const isRemote = !url.startsWith("file:");

module.exports = { db, ready, backupToFile, isRemote, DATA_DIR, close: () => client.close() };
