// Excel + PDF downloads for every section of the app.
//   GET /api/export/<section>.<xlsx|pdf>?from=YYYY-MM-DD&to=YYYY-MM-DD   (or ?date= for the day book)
//   GET /api/sales/<id>/receipt.pdf
// Each section builds the same tables once; they are then written as Excel or as PDF.
"use strict";
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const path = require("path");
const fs = require("fs");
const LOGO = path.join(__dirname, "public", "brand", "logo-192.png");
const hasLogo = () => fs.existsSync(LOGO);

module.exports = function registerExports(app, ctx) {
  const { db, stockLevels, report, can, settings, userNames, localDate, timeHM, dayStart, dayEnd, isDate, auth, audit, num } = ctx;
  const TYPE_LABEL = { opening: "Opening stock", purchase: "Bought", produced: "Made in kitchen", returned: "Returned", used: "Used in kitchen", damaged: "Damaged", expired: "Expired", gift: "Free gift", count: "Count correction" };
  const time = timeHM;
  const when = (t) => (t ? `${localDate(new Date(t))} ${time(t)}` : "");
  const byUser = (q, col = "user_id") => (q.user ? ` AND ${col} = ${Number(q.user) | 0}` : "");
  // column: [header, key, type, weight]  type: t=text m=money q=quantity p=percent
  const C = (h, k, type = "t", w = 1) => ({ h, k, type, w });

  // ------------------------------------------------------------------ sections
  const SECTIONS = {
    sales: { perm: "sales.view", title: "Sales & receipts", range: true, userFilter: true, async build(q, user) {
      const names = (await userNames()), rows = (await db.all("SELECT * FROM sales WHERE date BETWEEN ? AND ?" + byUser(q) + " ORDER BY t", q.from, q.to));
      const items = (await db.all("SELECT si.* FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.date BETWEEN ? AND ?" + byUser(q, "s.user_id"), q.from, q.to));
      const by = {}; for (const i of items) (by[i.sale_id] ||= []).push(i);
      const ok = rows.filter((r) => !r.voided);
      return [{ heading: "Receipts", landscape: true,
        cols: [C("Receipt", "receipt_no", "t", 1.1), C("Date", "date", "t", 0.9), C("Time", "time", "t", 0.5), C("Customer", "customer", "t", 1.2), C("Items", "items", "t", 3), C("Paid by", "method", "t", 1), C("Cashier", "who", "t", 1.1), C("Discount", "discount", "m", 0.8), C("Total", "total", "m", 0.9), C("Status", "status", "t", 0.9)],
        rows: rows.map((r) => ({ ...r, time: time(r.t), who: names[r.user_id] || "", items: (by[r.id] || []).map((i) => `${i.qty}x ${i.name}`).join(", "), status: r.voided ? "CANCELLED" : "Paid" })),
        totals: { receipt_no: `${ok.length} receipts`, total: ok.reduce((a, r) => a + r.total, 0), discount: ok.reduce((a, r) => a + r.discount, 0) } }];
    } },

    items: { perm: "stock.view", title: "Items & prices", async build(q, user) {
      const C2 = can(user, "costs.view"), P = (await stockLevels()).filter((p) => !p.archived);
      const cols = [C("Code", "sku", "t", 0.8), C("Item", "name", "t", 2.2), C("Category", "category", "t", 1.4), C("Unit", "unit", "t", 0.7), C("Selling price", "price", "m", 1)];
      if (C2) cols.push(C("Cost price", "cost", "m", 1), C("Margin", "margin", "p", 0.7));
      cols.push(C("In stock", "on_hand", "q", 0.8), C("Reorder at", "reorder", "q", 0.8), C("Type", "kind", "t", 0.9));
      return [{ heading: "Items", landscape: C2, cols, rows: P.map((p) => ({ ...p, margin: p.price ? (p.price - p.cost) / p.price : null, kind: p.sellable ? "For sale" : "Ingredient" })) }];
    } },

    inventory: { perm: "stock.view", title: "Stock levels", async build(q, user) {
      const C2 = can(user, "costs.view"), upto = isDate(q.date) ? q.date : null, P = (await stockLevels(upto)).filter((p) => !p.archived);
      const st = { ok: "OK", low: "LOW - reorder", check: "Check count", none: "Made to order" };
      const cols = [C("Item", "name", "t", 2.2), C("Category", "category", "t", 1.4), C("In stock", "on_hand", "q", 0.9), C("Unit", "unit", "t", 0.7), C("Reorder at", "reorder", "q", 0.9), C("Status", "st", "t", 1.1)];
      if (C2) cols.push(C("Cost each", "cost", "m", 1), C("Stock value", "val", "m", 1.1));
      const rows = P.map((p) => ({ ...p, st: st[p.status], val: Math.max(p.on_hand, 0) * p.cost }));
      return [{ heading: upto ? `Stock on ${upto}` : "Stock now", landscape: C2, cols, rows, totals: C2 ? { name: `${rows.length} items`, val: rows.reduce((a, r) => a + r.val, 0) } : null }];
    } },

    movements: { perm: "stock.view", title: "Stock movements", range: true, userFilter: true, async build(q, user) {
      const C2 = can(user, "costs.view"), names = (await userNames());
      const rows = (await db.all("SELECT m.*, p.name, p.unit FROM stock_moves m JOIN products p ON p.id=m.product_id WHERE m.date BETWEEN ? AND ?" + byUser(q, "m.user_id") + " ORDER BY m.t", q.from, q.to));
      const cols = [C("Date", "date", "t", 0.9), C("Time", "time", "t", 0.5), C("Item", "name", "t", 1.8), C("Type", "type_l", "t", 1.1), C("Qty", "qty", "q", 0.6)];
      if (C2) cols.push(C("Cost each", "unit_cost", "m", 0.9));
      cols.push(C("Supplier / by", "supplier", "t", 1.1), C("Ref", "ref", "t", 0.8), C("Note", "note", "t", 1.5), C("Recorded by", "who", "t", 1), C("Status", "status", "t", 0.9));
      return [{ heading: "Stock movements (sales are not included)", landscape: true, cols,
        rows: rows.map((m) => ({ ...m, time: time(m.t), type_l: TYPE_LABEL[m.type] || m.type, who: names[m.user_id] || "", status: m.voided ? "CANCELLED" : "OK" })) }];
    } },

    expenses: { perm: "expense.view", title: "Expenses", range: true, userFilter: true, async build(q) {
      const names = (await userNames()), rows = (await db.all("SELECT * FROM expenses WHERE date BETWEEN ? AND ?" + byUser(q) + " ORDER BY t", q.from, q.to)), ok = rows.filter((r) => !r.voided);
      const cat = {}; for (const e of ok) cat[e.category] = (cat[e.category] || 0) + e.amount;
      return [{ heading: "Expenses", landscape: true,
        cols: [C("Date", "date", "t", 0.9), C("Type", "category", "t", 1.2), C("Description", "description", "t", 2.2), C("Paid by", "method", "t", 1), C("Note", "note", "t", 1.5), C("Recorded by", "who", "t", 1), C("Amount", "amount", "m", 1), C("Status", "status", "t", 0.9)],
        rows: rows.map((e) => ({ ...e, who: names[e.user_id] || "", status: e.voided ? "CANCELLED" : "OK" })), totals: { date: "Total", amount: ok.reduce((a, e) => a + e.amount, 0) } },
      { heading: "Expenses by type", cols: [C("Type", "name", "t", 2), C("Amount", "v", "m", 1)], rows: Object.entries(cat).sort((a, b) => b[1] - a[1]).map(([name, v]) => ({ name, v })), totals: { name: "Total", v: ok.reduce((a, e) => a + e.amount, 0) } }];
    } },

    daybook: { perm: "daybook", title: "Day book", day: true, async build(q, user) {
      const d = q.date, C2 = can(user, "costs.view"), names = (await userNames());
      const sales = (await db.all("SELECT * FROM sales WHERE date = ? ORDER BY t", d)), ok = sales.filter((s) => !s.voided);
      const items = (await db.all("SELECT si.* FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.date = ?", d));
      const by = {}; for (const i of items) (by[i.sale_id] ||= []).push(i);
      const exp = (await db.all("SELECT * FROM expenses WHERE date = ? ORDER BY t", d)), expOk = exp.filter((e) => !e.voided);
      const moves = (await db.all("SELECT m.*, p.name, p.unit FROM stock_moves m JOIN products p ON p.id=m.product_id WHERE m.date = ? ORDER BY m.t", d));
      const sold = {}, cin = {}, cout = {};
      for (const s of ok) for (const i of by[s.id] || []) if (i.product_id) sold[i.product_id] = (sold[i.product_id] || 0) + i.qty;
      for (const m of moves) if (!m.voided && m.type !== "opening") { const t = m.qty > 0 ? cin : cout; t[m.product_id] = (t[m.product_id] || 0) + Math.abs(m.qty); }
      const salesTot = ok.reduce((a, s) => a + s.total, 0), expTot = expOk.reduce((a, e) => a + e.amount, 0);
      const byM = {}; for (const s of ok) byM[s.method] = (byM[s.method] || 0) + s.total;
      const summary = [{ k: "Sales", v: salesTot }, { k: "Receipts", v: ok.length, plain: true }, { k: "Expenses", v: expTot }, { k: "Sales minus expenses", v: salesTot - expTot },
        ...Object.entries(byM).map(([m, v]) => ({ k: `Received by ${m}`, v })), { k: "Cancelled sales", v: sales.length - ok.length, plain: true }];
      return [
        { heading: "Summary", cols: [C("", "k", "t", 2), C("Amount (RWF)", "v", "m", 1)], rows: summary },
        { heading: "Receipts", landscape: true, cols: [C("Time", "time", "t", 0.5), C("Receipt", "receipt_no", "t", 1), C("Items", "items", "t", 3), C("Customer", "customer", "t", 1.1), C("Paid by", "method", "t", 1), C("Cashier", "who", "t", 1), C("Total", "total", "m", 0.9), C("Status", "status", "t", 0.9)],
          rows: sales.map((s) => ({ ...s, time: time(s.t), items: (by[s.id] || []).map((i) => `${i.qty}x ${i.name}`).join(", "), who: names[s.user_id] || "", status: s.voided ? "CANCELLED" : "Paid" })), totals: { time: "Total", total: salesTot } },
        { heading: "Expenses", cols: [C("Time", "time", "t", 0.5), C("Type", "category", "t", 1.2), C("Description", "description", "t", 2), C("Paid by", "method", "t", 1), C("Amount", "amount", "m", 1), C("Status", "status", "t", 0.9)],
          rows: exp.map((e) => ({ ...e, time: time(e.t), status: e.voided ? "CANCELLED" : "OK" })), totals: { time: "Total", amount: expTot } },
        { heading: "Stock changes", cols: [C("Time", "time", "t", 0.5), C("Item", "name", "t", 1.8), C("Type", "type_l", "t", 1.1), C("Qty", "qty", "q", 0.6), C("Details", "det", "t", 2), C("Status", "status", "t", 0.9)],
          rows: moves.map((m) => ({ ...m, time: time(m.t), type_l: TYPE_LABEL[m.type] || m.type, det: [m.supplier, m.ref, m.note].filter(Boolean).join(" / "), status: m.voided ? "CANCELLED" : "OK" })) },
        { heading: "Stock at closing", cols: [C("Item", "name", "t", 2), C("Came in", "cin", "q", 0.8), C("Sold", "sold", "q", 0.8), C("Other out", "cout", "q", 0.8), C("Left at closing", "on_hand", "q", 1), C("Unit", "unit", "t", 0.7)],
          rows: (await stockLevels(d)).filter((p) => !p.archived).map((p) => ({ ...p, cin: cin[p.id] || 0, sold: sold[p.id] || 0, cout: cout[p.id] || 0 })) },
      ];
    } },

    reports: { perm: "reports", title: "Profit & loss report", range: true, async build(q) {
      const R = (await report(q.from, q.to)), pct = (a, b) => (b ? a / b : null);
      return [
        { heading: "Profit & loss", cols: [C("", "k", "t", 2.5), C("Amount (RWF)", "v", "m", 1)], rows: [
          { k: "Sales (money received)", v: R.sales }, { k: "Discounts given (already taken off)", v: R.discounts }, { k: "Cost of items sold", v: -R.cogs }, { k: "Gross profit", v: R.gross, bold: true },
          { k: "Expenses", v: -R.expenses }, { k: "Losses (damaged, expired, gifts)", v: -R.losses }, { k: "NET PROFIT", v: R.net, bold: true },
          { k: "Receipts", v: R.receipts, plain: true }, { k: "Average receipt", v: R.avg_receipt }, { k: "Stock bought (cash out, for information)", v: R.purchases }, { k: "Cancelled sales", v: R.voided, plain: true }] },
        { heading: "Sales by item", cols: [C("Item", "name", "t", 2.2), C("Qty sold", "qty", "q", 0.8), C("Sales", "v", "m", 1), C("Cost", "cost", "m", 1), C("Profit", "profit", "m", 1), C("Margin", "margin", "p", 0.7)],
          rows: R.by_item.map((i) => ({ ...i, profit: i.v - i.cost, margin: pct(i.v - i.cost, i.v) })), totals: { name: "Total", v: R.sales + R.discounts, cost: R.cogs, profit: R.sales + R.discounts - R.cogs } },
        { heading: "Sales by category", cols: [C("Category", "name", "t", 2), C("Sales", "v", "m", 1), C("Share", "share", "p", 0.7)], rows: R.by_category.map((r) => ({ ...r, share: pct(r.v, R.sales + R.discounts) })) },
        { heading: "Money by payment method", cols: [C("Payment method", "name", "t", 2), C("Receipts", "n", "q", 0.7), C("Amount", "v", "m", 1)], rows: R.by_method },
        { heading: "Sales by staff", cols: [C("Staff", "name", "t", 2), C("Receipts", "n", "q", 0.7), C("Amount", "v", "m", 1)], rows: R.by_staff },
        { heading: "Expenses by type", cols: [C("Type", "name", "t", 2), C("Amount", "v", "m", 1)], rows: R.exp_by_category, totals: { name: "Total", v: R.expenses } },
        { heading: "Sales per day", cols: [C("Date", "date", "t", 1), C("Receipts", "n", "q", 0.7), C("Sales", "v", "m", 1)], rows: R.by_day, totals: { date: "Total", n: R.receipts, v: R.sales } },
      ];
    } },

    activity: { perm: null, title: "Activity", range: true, userFilter: true, async build(q, user) {
      const uid = Number(q.user) | 0, C2 = can(user, "costs.view");
      const sales = (await db.all("SELECT * FROM sales WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY t", uid, q.from, q.to)), ok = sales.filter((s) => !s.voided);
      const items = (await db.all("SELECT si.* FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.user_id = ? AND s.date BETWEEN ? AND ?", uid, q.from, q.to));
      const by = {}; for (const i of items) (by[i.sale_id] ||= []).push(i);
      const exp = (await db.all("SELECT * FROM expenses WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY t", uid, q.from, q.to)), expOk = exp.filter((x) => !x.voided);
      const moves = (await db.all("SELECT m.*, p.name, p.unit FROM stock_moves m JOIN products p ON p.id=m.product_id WHERE m.user_id = ? AND m.date BETWEEN ? AND ? ORDER BY m.t", uid, q.from, q.to));
      const a = dayStart(q.from), b = dayEnd(q.to);
      const acts = (await db.all("SELECT * FROM audit WHERE user_id = ? AND t BETWEEN ? AND ? ORDER BY t", uid, a, b));
      const byM = {}; for (const s of ok) byM[s.method] = (byM[s.method] || 0) + s.total;
      const salesTot = ok.reduce((x, s) => x + s.total, 0), expTot = expOk.reduce((x, e) => x + e.amount, 0);
      const days = new Set([...sales.map((s) => s.date), ...exp.map((x) => x.date), ...moves.map((m) => m.date)]).size;
      return [
        { heading: "Summary", cols: [C("", "k", "t", 2.2), C("Value", "v", "m", 1)], rows: [
          { k: "Days with activity", v: days, plain: true }, { k: "Sales made (receipts)", v: ok.length, plain: true }, { k: "Money taken in sales (RWF)", v: salesTot },
          ...Object.entries(byM).map(([m, v]) => ({ k: `  of which ${m} (RWF)`, v })), { k: "Sales cancelled", v: sales.length - ok.length, plain: true },
          { k: "Expenses recorded", v: expOk.length, plain: true }, { k: "Expenses amount (RWF)", v: expTot }, { k: "Stock changes recorded", v: moves.filter((m) => !m.voided).length, plain: true },
          { k: "Log-ins", v: acts.filter((x) => x.action === "login.ok").length, plain: true }, { k: "Wrong-password attempts", v: acts.filter((x) => x.action === "login.failed").length, plain: true }] },
        { heading: "Sales made", landscape: true, cols: [C("Receipt", "receipt_no", "t", 1.1), C("Date", "date", "t", 0.9), C("Time", "time", "t", 0.5), C("Customer", "customer", "t", 1.1), C("Items", "items", "t", 3), C("Paid by", "method", "t", 1), C("Total", "total", "m", 0.9), C("Status", "status", "t", 0.9)],
          rows: sales.map((s) => ({ ...s, time: time(s.t), items: (by[s.id] || []).map((i) => `${i.qty}x ${i.name}`).join(", "), status: s.voided ? "CANCELLED" : "Paid" })), totals: { receipt_no: `${ok.length} receipts`, total: salesTot } },
        { heading: "Expenses recorded", cols: [C("Date", "date", "t", 0.9), C("Type", "category", "t", 1.2), C("Description", "description", "t", 2.2), C("Paid by", "method", "t", 1), C("Amount", "amount", "m", 1), C("Status", "status", "t", 0.9)],
          rows: exp.map((x) => ({ ...x, status: x.voided ? "CANCELLED" : "OK" })), totals: { date: "Total", amount: expTot } },
        { heading: "Stock changes recorded", cols: [C("Date", "date", "t", 0.9), C("Time", "time", "t", 0.5), C("Item", "name", "t", 1.8), C("Type", "type_l", "t", 1.1), C("Qty", "qty", "q", 0.6), ...(C2 ? [C("Cost each", "unit_cost", "m", 0.9)] : []), C("Details", "det", "t", 1.8), C("Status", "status", "t", 0.9)],
          rows: moves.map((m) => ({ ...m, time: time(m.t), type_l: TYPE_LABEL[m.type] || m.type, det: [m.supplier, m.ref, m.note].filter(Boolean).join(" / "), status: m.voided ? "CANCELLED" : "OK" })) },
        { heading: "Everything done in the system", landscape: true, cols: [C("When", "when", "t", 1.2), C("Action", "action", "t", 1.3), C("Details", "detail", "t", 3.4), C("Device IP", "ip", "t", 0.9)], rows: acts.map((r) => ({ ...r, when: when(r.t) })) },
      ];
    } },

    customers: { perm: "customers", title: "Customers", async build() {
      const rows = (await db.all(`SELECT c.*, COUNT(s.id) visits, COALESCE(SUM(s.total),0) spent, MAX(s.date) last_visit FROM customers c
        LEFT JOIN sales s ON s.customer_id = c.id AND s.voided = 0 GROUP BY c.id ORDER BY spent DESC, c.name`));
      return [{ heading: "Customers", cols: [C("Name", "name", "t", 1.8), C("Phone", "phone", "t", 1.2), C("Visits", "visits", "q", 0.6), C("Total spent", "spent", "m", 1), C("Last visit", "last_visit", "t", 0.9), C("Note", "note", "t", 1.8)], rows }];
    } },

    users: { perm: "users", title: "Users & roles", async build() {
      const R = { admin: "Administrator", manager: "Manager", cashier: "Cashier" }, S = { active: "Active", pending: "Waiting approval", disabled: "Switched off" };
      const rows = (await db.all("SELECT name, username, phone, role, status, must_change, created_t, last_login_t FROM users ORDER BY name"));
      return [{ heading: "Accounts", landscape: true, cols: [C("Name", "name", "t", 1.6), C("Username", "username", "t", 1), C("Phone", "phone", "t", 1.1), C("Role", "role_l", "t", 1), C("Status", "status_l", "t", 1.1), C("Created", "created", "t", 1.2), C("Last login", "last", "t", 1.2)],
        rows: rows.map((u) => ({ ...u, role_l: R[u.role], status_l: S[u.status] + (u.must_change ? " (must change password)" : ""), created: when(u.created_t), last: when(u.last_login_t) })) }];
    } },

    audit: { perm: "audit", title: "Audit log", range: true, async build(q) {
      const a = dayStart(q.from), b = dayEnd(q.to);
      const rows = (await db.all("SELECT a.*, u.name FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.t BETWEEN ? AND ? ORDER BY a.t DESC LIMIT 20000", a, b));
      return [{ heading: "Every recorded action", landscape: true, cols: [C("When", "when", "t", 1.2), C("Who", "name", "t", 1.2), C("Action", "action", "t", 1.3), C("Details", "detail", "t", 3.2), C("Device IP", "ip", "t", 0.9)],
        rows: rows.map((r) => ({ ...r, when: when(r.t), name: r.name || (r.ip === "terminal" ? "Terminal tool" : "—") })) }];
    } },
  };

  // ------------------------------------------------------------------ writers
  const S = settings;
  async function writeXlsx(res, doc) {
    const wb = new ExcelJS.Workbook(); wb.creator = doc.shop; wb.created = new Date();
    const used = new Set(), logoId = hasLogo() ? wb.addImage({ filename: LOGO, extension: "png" }) : null;
    for (const t of doc.tables) {
      let name = (t.heading || doc.title).replace(/[\\/*?:[\]]/g, "").slice(0, 31) || "Sheet"; let n = 2; while (used.has(name)) name = name.slice(0, 28) + " " + n++; used.add(name);
      const ws = wb.addWorksheet(name, { pageSetup: { orientation: t.landscape ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
      ws.addRow([`${doc.shop} — ${doc.title}`]).font = { bold: true, size: 14, color: { argb: "FF0E7C7B" } };
      ws.addRow([`${t.heading}${doc.period ? "  ·  " + doc.period : ""}`]).font = { bold: true, size: 11 };
      ws.addRow([`Downloaded ${when(Date.now())} by ${doc.by}`]).font = { italic: true, size: 9, color: { argb: "FF5D6B79" } };
      ws.addRow([]);
      const hr = ws.addRow(t.cols.map((c) => c.h));
      hr.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0E7C7B" } }; c.alignment = { vertical: "middle", wrapText: true }; });
      hr.height = 20;
      t.cols.forEach((c, i) => { const col = ws.getColumn(i + 1); col.width = Math.max(10, Math.round(c.w * 14)); if (c.type === "m") col.numFmt = "#,##0"; if (c.type === "q") col.numFmt = "#,##0.##"; if (c.type === "p") col.numFmt = "0%"; if (c.type !== "t") col.alignment = { horizontal: "right" }; });
      const first = ws.rowCount + 1;
      for (const r of t.rows) { const row = ws.addRow(t.cols.map((c) => (c.type === "t" ? r[c.k] ?? "" : r.plain && c.type === "m" ? r[c.k] : r[c.k] ?? null))); if (r.bold) row.font = { bold: true }; if (String(r.status || "").startsWith("CANCELLED")) row.font = { color: { argb: "FFB0B0B0" }, strike: true }; }
      if (!t.rows.length) ws.addRow(["(nothing in this period)"]).font = { italic: true, color: { argb: "FF5D6B79" } };
      if (t.totals) { const tr = ws.addRow(t.cols.map((c) => t.totals[c.k] ?? null)); tr.font = { bold: true }; tr.eachCell((c) => { c.border = { top: { style: "thin" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEF2F5" } }; }); }
      ws.views = [{ state: "frozen", ySplit: first - 1 }];
      if (logoId != null) ws.addImage(logoId, { tl: { col: Math.max(t.cols.length - 1, 1), row: 0 }, ext: { width: 58, height: 58 }, editAs: "absolute" });
      if (t.rows.length) ws.autoFilter = { from: { row: first - 1, column: 1 }, to: { row: first - 1, column: t.cols.length } };
    }
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${doc.file}.xlsx"`);
    await wb.xlsx.write(res); res.end();
  }

  const pdfText = (v) => String(v ?? "").replace(/[−–—]/g, "-").replace(/→/g, "->").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, "?");
  const fmtCell = (c, r) => {
    const v = r[c.k];
    if (c.type === "t") return pdfText(v);
    if (v == null || v === "") return "";
    if (c.type === "p") return Math.round(v * 100) + "%";
    if (c.type === "m" && !r.plain) return (v < 0 ? "-" : "") + Math.round(Math.abs(v)).toLocaleString("en-US");
    return Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
  };
  function writePdf(res, doc) {
    const landscape = doc.tables.some((t) => t.landscape);
    const pdf = new PDFDocument({ size: "A4", layout: landscape ? "landscape" : "portrait", margin: 36, bufferPages: true, info: { Title: `${doc.shop} - ${doc.title}`, Author: doc.by, Creator: "Grathia Shop Manager" } });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${doc.file}.pdf"`);
    pdf.pipe(res);
    const L = pdf.page.margins.left, W = pdf.page.width - L - pdf.page.margins.right, bottom = () => pdf.page.height - pdf.page.margins.bottom - 18;
    const TEAL = "#0e7c7b", INK = "#101b25", MUTE = "#5d6b79", LINE = "#dfe5ea", ZEBRA = "#f4f7f9";
    // title block
    pdf.rect(0, 0, pdf.page.width, 6).fill(TEAL);
    const TX = hasLogo() ? L + 72 : L;
    if (hasLogo()) pdf.image(LOGO, L, 20, { width: 62, height: 62 });
    pdf.fillColor(TEAL).font("Helvetica-Bold").fontSize(17).text(pdfText(doc.shop), TX, 26);
    pdf.fillColor(MUTE).font("Helvetica").fontSize(9).text(pdfText([doc.tagline, doc.address, doc.phone].filter(Boolean).join("  |  ")), TX, pdf.y + 1);
    pdf.fillColor(INK).font("Helvetica-Bold").fontSize(14).text(pdfText(doc.title), TX, pdf.y + 8);
    pdf.fillColor(MUTE).font("Helvetica").fontSize(9).text(pdfText(`${doc.period ? doc.period + "   |   " : ""}Downloaded ${when(Date.now())} by ${doc.by}`), TX, pdf.y + 2);
    pdf.y = Math.max(pdf.y, 86);
    pdf.moveTo(L, pdf.y + 8).lineTo(L + W, pdf.y + 8).strokeColor(LINE).lineWidth(1).stroke();
    pdf.y += 18;
    const RH = 17, FS = 8.5;
    for (const t of doc.tables) {
      const tw = t.cols.reduce((a, c) => a + c.w, 0), ws = t.cols.map((c) => (c.w / tw) * W);
      const header = () => {
        pdf.rect(L, pdf.y, W, RH + 2).fill(TEAL); let x = L; const y = pdf.y + 5.5;
        pdf.fillColor("#fff").font("Helvetica-Bold").fontSize(FS);
        t.cols.forEach((c, i) => { pdf.text(pdfText(c.h), x + 4, y, { width: ws[i] - 8, height: RH, lineBreak: false, ellipsis: true, align: c.type === "t" ? "left" : "right" }); x += ws[i]; });
        pdf.y = y - 5.5 + RH + 2;
      };
      if (pdf.y + 60 > bottom()) pdf.addPage();
      pdf.fillColor(INK).font("Helvetica-Bold").fontSize(11.5).text(pdfText(t.heading), L, pdf.y, { width: W }); pdf.y += 4;
      header();
      const rows = t.rows.length ? t.rows : [{ __empty: true }];
      rows.forEach((r, ri) => {
        if (pdf.y + RH > bottom()) { pdf.addPage(); header(); }
        const y = pdf.y; if (ri % 2) pdf.rect(L, y, W, RH).fill(ZEBRA);
        const cancelled = String(r.status || "").startsWith("CANCELLED");
        pdf.font(r.bold ? "Helvetica-Bold" : "Helvetica").fontSize(FS).fillColor(cancelled ? "#a0a7ad" : INK);
        if (r.__empty) pdf.fillColor(MUTE).text("Nothing in this period.", L + 4, y + 5, { width: W - 8 });
        else { let x = L; t.cols.forEach((c, i) => { pdf.text(fmtCell(c, r), x + 4, y + 5, { width: ws[i] - 8, height: RH, lineBreak: false, ellipsis: true, align: c.type === "t" ? "left" : "right" }); x += ws[i]; }); }
        if (cancelled) pdf.moveTo(L + 4, y + RH / 2).lineTo(L + W - 4, y + RH / 2).strokeColor("#c9cfd4").lineWidth(0.6).stroke();
        pdf.y = y + RH;
      });
      if (t.totals) {
        if (pdf.y + RH > bottom()) { pdf.addPage(); header(); }
        const y = pdf.y; pdf.rect(L, y, W, RH + 1).fill("#e6eef0"); pdf.moveTo(L, y).lineTo(L + W, y).strokeColor(TEAL).lineWidth(1).stroke();
        let x = L; pdf.font("Helvetica-Bold").fontSize(FS).fillColor(INK);
        t.cols.forEach((c, i) => { const v = t.totals[c.k]; if (v != null) pdf.text(typeof v === "number" ? fmtCell({ ...c, type: c.type === "t" ? "q" : c.type }, { [c.k]: v }) : pdfText(v), x + 4, y + 5, { width: ws[i] - 8, height: RH, lineBreak: false, ellipsis: true, align: c.type === "t" && typeof v !== "number" ? "left" : "right" }); x += ws[i]; });
        pdf.y = y + RH + 1;
      }
      pdf.y += 16;
    }
    const range = pdf.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      pdf.switchToPage(i); const y = pdf.page.height - pdf.page.margins.bottom - 4;
      pdf.font("Helvetica").fontSize(7.5).fillColor(MUTE);
      pdf.text(pdfText(`${doc.shop} - ${doc.title}`), L, y, { width: W / 2, lineBreak: false });
      pdf.text(`Page ${i + 1} of ${range.count}`, L + W / 2, y, { width: W / 2, align: "right", lineBreak: false });
    }
    pdf.end();
  }

  // ------------------------------------------------------------------ routes
  app.get("/api/export/:name", auth, async (req, res, next) => {
    try {
      const m = /^([a-z]+)\.(xlsx|pdf)$/.exec(req.params.name); const sec = m && SECTIONS[m[1]];
      if (!sec) return res.status(404).json({ error: "Unknown export." });
      if (sec.perm && !can(req.user, sec.perm)) return res.status(403).json({ error: "You don't have permission to download this." });
      const today = localDate(), q = { ...req.query };
      if (m[1] === "activity" && !q.user) q.user = String(req.user.id);          // "My activity" by default
      if (!sec.userFilter) delete q.user;
      let person = null;
      if (q.user) {
        person = (await db.get("SELECT id, name FROM users WHERE id = ?", Number(q.user) | 0));
        if (!person) return res.status(404).json({ error: "That person was not found." });
        if (m[1] === "activity" && person.id !== req.user.id && !(can(req.user, "users") || can(req.user, "reports")))
          return res.status(403).json({ error: "You can only download your own activity." });
      }
      if (sec.range) { q.to = isDate(q.to) ? q.to : today; q.from = isDate(q.from) ? q.from : q.to.slice(0, 8) + "01"; if (q.from > q.to) [q.from, q.to] = [q.to, q.from]; }
      if (sec.day) q.date = isDate(q.date) ? q.date : today;
      const s = (await S()), period = sec.range ? (q.from === q.to ? q.from : `${q.from} to ${q.to}`) : sec.day ? q.date : q.date && isDate(q.date) ? `On ${q.date}` : `As at ${when(Date.now())}`;
      const title = m[1] === "activity" ? `Activity of ${person.name}` : person ? `${sec.title} — recorded by ${person.name}` : sec.title;
      const slug = (x) => String(x).replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "");
      const doc = { shop: s.shop_name, tagline: s.shop_tagline, address: s.shop_address, phone: s.shop_phone, title, period, by: req.user.name,
        tables: await sec.build(q, req.user), file: `${slug(s.shop_name)}_${m[1]}${person ? "_" + slug(person.name) : ""}_${sec.range ? q.from + "_to_" + q.to : sec.day ? q.date : today}` };
      await audit(req, "export." + m[2], `${m[1]} ${period}`);
      if (m[2] === "xlsx") await writeXlsx(res, doc); else writePdf(res, doc);
    } catch (e) { next(e); }
  });

  app.get("/api/sales/:id/receipt.pdf", auth, async (req, res, next) => {
    try {
      if (!can(req.user, "sales.view")) return res.status(403).json({ error: "You don't have permission." });
      const s = (await db.get("SELECT * FROM sales WHERE id = ?", num(req.params.id))); if (!s) return res.status(404).json({ error: "Receipt not found." });
      const items = (await db.all("SELECT * FROM sale_items WHERE sale_id = ?", s.id)), st = (await S()), names = (await userNames());
      const W = 226, H = 330 + items.length * 30 + (s.discount ? 14 : 0) + (s.voided ? 40 : 0) + (s.customer ? 12 : 0);
      const pdf = new PDFDocument({ size: [W, H], margin: 12, info: { Title: `Receipt ${s.receipt_no}` } });
      res.setHeader("Content-Type", "application/pdf"); res.setHeader("Content-Disposition", `inline; filename="Receipt_${s.receipt_no}.pdf"`);
      pdf.pipe(res);
      const w = W - 24, line = () => { pdf.moveDown(0.3); pdf.moveTo(12, pdf.y).lineTo(W - 12, pdf.y).dash(2, { space: 2 }).strokeColor("#888").stroke().undash(); pdf.moveDown(0.5); };
      const lr = (a, b, bold) => { const y = pdf.y; pdf.font(bold ? "Courier-Bold" : "Courier").fontSize(8.5).text(pdfText(a), 12, y, { width: w * 0.42 }); const y2 = pdf.y; pdf.text(pdfText(b), 12 + w * 0.42, y, { width: w * 0.58, align: "right" }); pdf.y = Math.max(y2, pdf.y); };
      if (hasLogo()) { pdf.image(LOGO, (W - 72) / 2, 10, { width: 72, height: 72 }); pdf.y = 88; }
      pdf.fillColor("#000").font("Helvetica-Bold").fontSize(12).text(pdfText(st.shop_name), 12, pdf.y, { align: "center", width: w });
      pdf.font("Helvetica").fontSize(7.5).text(pdfText([st.shop_tagline, st.shop_address, st.shop_phone].filter(Boolean).join("\n")), { align: "center", width: w });
      line();
      if (s.voided) { pdf.font("Helvetica-Bold").fontSize(10).fillColor("#c00").text("CANCELLED", 12, pdf.y, { align: "center", width: w }); pdf.font("Helvetica").fontSize(7.5).text(pdfText(s.void_reason || ""), 12, pdf.y, { align: "center", width: w }); pdf.fillColor("#000"); line(); }
      pdf.font("Courier").fontSize(8.5);
      lr("Receipt", s.receipt_no); lr("Date", `${s.date} ${time(s.t)}`); lr("Cashier", names[s.user_id] || "-"); if (s.customer) lr("Customer", s.customer);
      line();
      const f = (n) => Math.round(n).toLocaleString("en-US");
      for (const i of items) { pdf.font("Courier-Bold").fontSize(8.5).text(pdfText(i.name), 12, pdf.y, { width: w }); const y = pdf.y; pdf.font("Courier").text(`  ${i.qty} x ${f(i.price)}`, 12, y, { width: w * 0.6 }); pdf.text(f(i.line_total), 12 + w * 0.6, y, { width: w * 0.4, align: "right" }); }
      line();
      lr("Subtotal", f(s.subtotal)); if (s.discount) lr("Discount", "-" + f(s.discount)); lr(`TOTAL (${st.currency || "RWF"})`, f(s.total), true); lr("Paid by", s.method);
      line();
      pdf.font("Helvetica").fontSize(7.5).text(pdfText(st.receipt_footer || ""), 12, pdf.y, { align: "center", width: w });
      pdf.end();
      await audit(req, "receipt.pdf", s.receipt_no);
    } catch (e) { next(e); }
  });
};
