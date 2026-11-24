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
  // First start only: the shop's starting items and the first recorded sale (from the Excel file).
  // A marker makes sure they are never added again (for example after "npm run admin -- reset-data").
  await db.tx(async (t) => {
    if (await t.get("SELECT value FROM settings WHERE key = 'seed_done'")) return;
    await t.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('seed_done', '1')");
    if ((await t.get("SELECT COUNT(*) AS n FROM products")).n !== 0) return;
    const ts = Date.now();
    const addP = "INSERT INTO products (sku, name, category, unit, cost, price, reorder, sellable, created_t) VALUES (?,?,?,?,?,?,?,?,?)";
    const cake = (await t.run(addP, "GSH-0001", "Birthday cake medium", "Birthday Cakes", "Cake", 10000, 10000, 1, 1, ts)).lastInsertRowid;
    const mandazi = (await t.run(addP, "GSH-0002", "Special mandazi", "Snacks", "Piece", 0, 100, 10, 1, ts)).lastInsertRowid;
    await t.run(addP, "GSH-0003", "Fresh juice (small)", "Fresh Juice", "Cup", 0, 2500, 0, 1, ts);
    await t.run(addP, "GSH-0004", "Fresh juice (large)", "Fresh Juice", "Cup", 0, 3000, 0, 1, ts);
    await t.run("INSERT INTO stock_moves (date, t, product_id, type, qty, unit_cost, note) VALUES (?,?,?,?,?,?,?)", "2026-11-23", ts, cake, "opening", 2, 10000, "Opening stock");
    const sale = (await t.run(`INSERT INTO sales (receipt_no, date, t, customer, subtotal, discount, total, method, note)
      VALUES ('R261123-001', '2026-11-23', ?, 'ISHIMWE Hervin', 800, 0, 800, 'Airtel Money', 'Imported from Excel')`, Date.parse("2026-11-23T12:00:00Z"))).lastInsertRowid;
    await t.run("INSERT INTO sale_items (sale_id, product_id, name, qty, price, cost, line_total) VALUES (?,?,?,?,?,?,?)", sale, mandazi, "Special mandazi", 8, 100, 0, 800);
    console.log("  New database created with starting items.");
  });
}
const ready = init();
ready.catch((e) => console.error("Database start-up failed:", e));

// Copy the whole database into a new SQLite file (works for Turso and local). Returns the file path.
async function backupToFile(file = path.join(os.tmpdir(), `grathia-backup-${Date.now()}.db`)) {
  const out = createClient({ url: "file:" + file.replace(/\\/g, "/") });
  try {
    const objs = (await db.all("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'libsql_%' AND name NOT LIKE '!_%' ESCAPE '!' ORDER BY type = 'index'"));
    for (const o of objs) {
      await out.execute(o.sql);
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
