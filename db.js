// Database: one SQLite file at ./data/grathia.db, created automatically on first start.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, "grathia.db");
const db = new DatabaseSync(DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

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
`);

// Upgrade older databases: allow custom (unlisted) items on sale lines.
{
  const col = db.prepare("PRAGMA table_info(sale_items)").all().find((c) => c.name === "product_id");
  if (col && col.notnull) {
    db.exec(`PRAGMA foreign_keys = OFF; BEGIN;
      CREATE TABLE sale_items_new (id INTEGER PRIMARY KEY AUTOINCREMENT, sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id), name TEXT NOT NULL, qty REAL NOT NULL, price REAL NOT NULL, cost REAL NOT NULL, line_total REAL NOT NULL);
      INSERT INTO sale_items_new (id, sale_id, product_id, name, qty, price, cost, line_total) SELECT id, sale_id, product_id, name, qty, price, cost, line_total FROM sale_items;
      DROP TABLE sale_items; ALTER TABLE sale_items_new RENAME TO sale_items;
      CREATE INDEX IF NOT EXISTS sale_items_sale ON sale_items(sale_id);
      COMMIT; PRAGMA foreign_keys = ON;`);
    console.log("  Database upgraded (custom sale items).");
  }
}

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
const putSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) putSetting.run(k, v);

// First start only: the shop's starting items and the first recorded sale (from the Excel file).
// A marker makes sure they are never added again (for example after "npm run admin -- reset-data").
const seedDone = db.prepare("SELECT value FROM settings WHERE key = 'seed_done'").get();
if (!seedDone && db.prepare("SELECT COUNT(*) AS n FROM products").get().n === 0) {
  const t = Date.now();
  const addP = db.prepare("INSERT INTO products (sku, name, category, unit, cost, price, reorder, sellable, created_t) VALUES (?,?,?,?,?,?,?,?,?)");
  const addM = db.prepare("INSERT INTO stock_moves (date, t, product_id, type, qty, unit_cost, note) VALUES (?,?,?,?,?,?,?)");
  const cake = addP.run("GSH-0001", "Birthday cake medium", "Birthday Cakes", "Cake", 10000, 10000, 1, 1, t).lastInsertRowid;
  const mandazi = addP.run("GSH-0002", "Special mandazi", "Snacks", "Piece", 0, 100, 10, 1, t).lastInsertRowid;
  addP.run("GSH-0003", "Fresh juice (small)", "Fresh Juice", "Cup", 0, 2500, 0, 1, t);
  addP.run("GSH-0004", "Fresh juice (large)", "Fresh Juice", "Cup", 0, 3000, 0, 1, t);
  addM.run("2026-11-23", t, cake, "opening", 2, 10000, "Opening stock");
  const sale = db.prepare(`INSERT INTO sales (receipt_no, date, t, customer, subtotal, discount, total, method, note)
    VALUES ('R261123-001', '2026-11-23', ?, 'ISHIMWE Hervin', 800, 0, 800, 'Airtel Money', 'Imported from Excel')`).run(Date.parse("2026-11-23T12:00:00Z")).lastInsertRowid;
  db.prepare("INSERT INTO sale_items (sale_id, product_id, name, qty, price, cost, line_total) VALUES (?,?,?,?,?,?,?)").run(sale, mandazi, "Special mandazi", 8, 100, 0, 800);
  console.log("  New database created with starting items.");
}
if (!seedDone) db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('seed_done', '1')").run();

module.exports = { db, DB_FILE, DATA_DIR };
