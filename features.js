// Customer debts (credit), cake orders with deposits, closing the day (cash count),
// who is online and what each person did.
"use strict";

module.exports = function registerFeatures(app, ctx) {
  const { db, auth, need, wrap, bad, str, num, money, isDate, localDate, dayStart, dayEnd, now, audit, can, settings, list,
    parsePayments, methodLabel, findOrCreateCustomer, insertSale, getSale } = ctx;
  const methodsOf = async () => list((await settings()).payment_methods);

  // ====================================================================
  // Customers & debts
  // ====================================================================
  // What each customer still owes = sum over their (not cancelled) sales of total − money paid for that sale.
  const OWED_SQL = `SELECT c.*, COUNT(s.id) visits, COALESCE(SUM(s.total),0) spent, MAX(s.date) last_visit,
      COALESCE(SUM(s.total - COALESCE(pp.paid,0)),0) owed,
      MIN(CASE WHEN s.total - COALESCE(pp.paid,0) > 0.001 THEN s.date END) owed_since
    FROM customers c
    LEFT JOIN sales s ON s.customer_id = c.id AND s.voided = 0
    LEFT JOIN (SELECT sale_id, SUM(amount) paid FROM payments WHERE voided = 0 AND sale_id IS NOT NULL GROUP BY sale_id) pp ON pp.sale_id = s.id
    GROUP BY c.id`;
  const roundOwed = (c) => ({ ...c, owed: Math.max(0, money(c.owed)) });

  app.get("/api/customers", auth, need("customers"), wrap(async (req, res) => {
    res.json({ customers: (await db.all(OWED_SQL + " ORDER BY spent DESC, c.name")).map(roundOwed) });
  }));
  app.get("/api/debts", auth, need("customers"), wrap(async (req, res) => {
    const rows = (await db.all(OWED_SQL + " ORDER BY owed DESC")).map(roundOwed).filter((c) => c.owed > 0.001);
    res.json({ debts: rows, total: money(rows.reduce((a, c) => a + c.owed, 0)) });
  }));

  // Statement: every sale to this customer with what is still owed, and every payment they made.
  async function statement(id) {
    const c = await db.get("SELECT * FROM customers WHERE id = ?", id); if (!c) bad("Customer not found.");
    const [sales, pays, orders] = await Promise.all([
      db.all(`SELECT s.id, s.receipt_no, s.date, s.t, s.total, s.method, s.voided, COALESCE(pp.paid,0) paid FROM sales s
        LEFT JOIN (SELECT sale_id, SUM(amount) paid FROM payments WHERE voided = 0 AND sale_id IS NOT NULL GROUP BY sale_id) pp ON pp.sale_id = s.id
        WHERE s.customer_id = ? ORDER BY s.t DESC LIMIT 500`, id),
      db.all(`SELECT p.*, s.receipt_no, o.order_no FROM payments p LEFT JOIN sales s ON s.id = p.sale_id LEFT JOIN orders o ON o.id = p.order_id
        WHERE (p.customer_id = ? OR s.customer_id = ? OR o.customer_id = ?) ORDER BY p.t DESC LIMIT 1000`, id, id, id),
      db.all("SELECT id, order_no, description, pickup_date, total, status FROM orders WHERE customer_id = ? ORDER BY t DESC LIMIT 100", id),
    ]);
    for (const s of sales) s.balance = s.voided ? 0 : Math.max(0, money(s.total - s.paid));
    const owed = money(sales.reduce((a, s) => a + s.balance, 0));
    return { customer: c, owed, sales, payments: pays, orders };
  }
  app.get("/api/customers/:id/statement", auth, need("customers"), wrap(async (req, res) => res.json(await statement(num(req.params.id)))));

  // A customer pays back (part of) what they owe. The money goes to their oldest unpaid sales first.
  app.post("/api/customers/:id/payments", auth, need("sell"), wrap(async (req, res) => {
    const id = num(req.params.id), b = req.body || {}, methods = await methodsOf();
    const amount = money(b.amount); if (amount <= 0) bad("Enter the amount received.");
    if (!methods.includes(b.method)) bad("Choose how the customer paid.");
    const date = isDate(b.date) ? b.date : localDate();
    if (date !== localDate() && !can(req.user, "sales.void")) bad("Only a manager can record a payment on another date.");
    const c = await db.tx(async (t) => {
      const c = await t.get("SELECT * FROM customers WHERE id = ?", id); if (!c) bad("Customer not found.");
      const open = await t.all(`SELECT s.id, s.receipt_no, s.total - COALESCE(pp.paid,0) bal FROM sales s
        LEFT JOIN (SELECT sale_id, SUM(amount) paid FROM payments WHERE voided = 0 AND sale_id IS NOT NULL GROUP BY sale_id) pp ON pp.sale_id = s.id
        WHERE s.customer_id = ? AND s.voided = 0 AND s.total - COALESCE(pp.paid,0) > 0.001 ORDER BY s.date, s.t`, id);
      const owed = money(open.reduce((a, s) => a + s.bal, 0));
      if (!owed) bad(`${c.name} does not owe anything.`);
      if (amount > owed + 0.001) bad(`${c.name} owes only ${owed.toLocaleString("en-US")} RWF. Enter that amount or less.`);
      let left = amount; const ts = now();
      for (const s of open) {
        if (left <= 0.001) break;
        const part = money(Math.min(left, s.bal)); left = money(left - part);
        await t.run("INSERT INTO payments (date, t, kind, method, amount, sale_id, customer_id, note, user_id) VALUES (?,?,?,?,?,?,?,?,?)",
          date, ts, "repayment", b.method, part, s.id, id, str(b.note, 200), req.user.id);
      }
      return { ...c, owed_after: money(owed - amount) };
    });
    await audit(req, "debt.paid", `${c.name} paid ${amount} by ${b.method}; still owes ${c.owed_after}`);
    res.json({ ok: true, owed: c.owed_after });
  }));

  // Cancel a repayment or deposit that was entered by mistake (managers).
  app.post("/api/payments/:id/void", auth, need("sales.void"), wrap(async (req, res) => {
    const reason = str(req.body.reason, 200); if (reason.length < 3) bad("Please write the reason.");
    const p = await db.get("SELECT * FROM payments WHERE id = ?", num(req.params.id)); if (!p) bad("Payment not found.");
    if (p.voided) bad("Already cancelled.");
    if (!["repayment", "deposit"].includes(p.kind)) bad("Payments made at the till are cancelled together with the sale.");
    if (p.order_id) { const o = await db.get("SELECT status FROM orders WHERE id = ?", p.order_id); if (o && o.status !== "open" && o.status !== "ready") bad("This order is already finished, so its deposit cannot be cancelled."); }
    await db.run("UPDATE payments SET voided=1, void_by=?, void_t=?, void_reason=? WHERE id=?", req.user.id, now(), reason, p.id);
    await audit(req, "payment.voided", `${p.kind} ${p.amount} ${p.method}: ${reason}`); res.json({ ok: true });
  }));

  // ====================================================================
  // Orders (e.g. cakes) with deposits
  // ====================================================================
  const ORDER_PAID = "LEFT JOIN (SELECT order_id, SUM(amount) paid FROM payments WHERE voided = 0 AND order_id IS NOT NULL GROUP BY order_id) op ON op.order_id = o.id";
  const orderOut = (o, user) => { const r = { ...o, paid: money(o.paid || 0) }; r.balance = money(r.total - r.paid); if (!can(user, "costs.view")) delete r.cost; return r; };
  async function getOrder(id, user) {
    const o = await db.get(`SELECT o.*, COALESCE(op.paid,0) paid FROM orders o ${ORDER_PAID} WHERE o.id = ?`, id); if (!o) bad("Order not found.");
    const r = orderOut(o, user);
    r.payments = await db.all("SELECT id, date, t, kind, method, amount, user_id, voided, void_reason FROM payments WHERE order_id = ? ORDER BY t", id);
    return r;
  }
  function orderFields(b, user) {
    const description = str(b.description, 300); if (!description) bad("Describe the order (e.g. 2-tier birthday cake, chocolate, 'Happy 5th birthday Gloria').");
    if (!isDate(b.pickup_date)) bad("Choose the pickup date.");
    const total = money(b.total); if (total <= 0) bad("Enter the full price of the order.");
    const pickup_time = /^\d{2}:\d{2}$/.test(String(b.pickup_time || "")) ? b.pickup_time : "";
    const cost = can(user, "costs.view") ? Math.max(0, money(b.cost)) : 0;
    return { description, pickup_date: b.pickup_date, pickup_time, total, cost, note: str(b.note, 300), phone: str(b.phone, 30) };
  }

  app.get("/api/orders", auth, need("sell"), wrap(async (req, res) => {
    const st = String(req.query.status || "upcoming");
    let where = "o.status IN ('open','ready')", args = [];
    if (st === "collected" || st === "cancelled") {
      const from = isDate(req.query.from) ? req.query.from : "0000-01-01", to = isDate(req.query.to) ? req.query.to : "9999-12-31";
      where = "o.status = ? AND o.pickup_date BETWEEN ? AND ?"; args = [st, from, to];
    }
    const rows = await db.all(`SELECT o.*, COALESCE(op.paid,0) paid FROM orders o ${ORDER_PAID} WHERE ${where} ORDER BY o.pickup_date ${st === "upcoming" ? "ASC" : "DESC"}, o.pickup_time LIMIT 1000`, ...args);
    res.json({ orders: rows.map((o) => orderOut(o, req.user)) });
  }));
  app.get("/api/orders/:id", auth, need("sell"), wrap(async (req, res) => res.json({ order: await getOrder(num(req.params.id), req.user) })));

  app.post("/api/orders", auth, need("sell"), wrap(async (req, res) => {
    const b = req.body || {}, f = orderFields(b, req.user), methods = await methodsOf();
    if (!str(b.customer, 60) && !num(b.customer_id)) bad("Enter the customer's name.");
    const dep = money(b.deposit);
    if (dep < 0 || dep > f.total) bad("The deposit must be between 0 and the full price.");
    if (dep > 0 && !methods.includes(b.deposit_method)) bad("Choose how the deposit was paid.");
    const id = await db.tx(async (t) => {
      const c = await findOrCreateCustomer(t, { id: b.customer_id, name: b.customer, phone: f.phone }, true);
      if (f.phone && !c.phone) await t.run("UPDATE customers SET phone = ? WHERE id = ?", f.phone, c.id);
      const ts = now(), date = localDate();
      const id = (await t.run(`INSERT INTO orders (t, date, customer_id, customer, phone, description, pickup_date, pickup_time, total, cost, note, status, user_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, ts, date, c.id, c.name, f.phone || c.phone || "", f.description, f.pickup_date, f.pickup_time, f.total, f.cost, f.note, "open", req.user.id)).lastInsertRowid;
      await t.run("UPDATE orders SET order_no = ? WHERE id = ?", "ORD-" + String(id).padStart(4, "0"), id);
      if (dep > 0) await t.run("INSERT INTO payments (date, t, kind, method, amount, order_id, customer_id, user_id) VALUES (?,?,?,?,?,?,?,?)", date, ts, "deposit", b.deposit_method, dep, id, c.id, req.user.id);
      return id;
    });
    const o = await getOrder(id, req.user);
    await audit(req, "order.created", `${o.order_no} for ${o.customer}: ${o.description} — ${o.total}, deposit ${dep}, pickup ${o.pickup_date}`);
    res.json({ ok: true, order: o });
  }));

  app.put("/api/orders/:id", auth, need("sell"), wrap(async (req, res) => {
    const o = await getOrder(num(req.params.id), req.user);
    if (!["open", "ready"].includes(o.status)) bad("This order is finished and cannot be changed.");
    const f = orderFields({ phone: o.phone, ...req.body, cost: can(req.user, "costs.view") ? req.body.cost : o.cost }, req.user);
    if (f.total < o.paid) bad("The price cannot be less than what the customer already paid.");
    if (f.total !== o.total && !can(req.user, "price.override") && o.user_id !== req.user.id) bad("Only a manager can change the price of someone else's order.");
    await db.run("UPDATE orders SET description=?, pickup_date=?, pickup_time=?, total=?, cost=?, note=?, phone=? WHERE id=?", f.description, f.pickup_date, f.pickup_time, f.total, f.cost, f.note, f.phone, o.id);
    await audit(req, "order.updated", `${o.order_no}${f.total !== o.total ? ` price ${o.total} → ${f.total}` : ""}${f.pickup_date !== o.pickup_date ? ` pickup ${o.pickup_date} → ${f.pickup_date}` : ""}`);
    res.json({ ok: true });
  }));

  app.post("/api/orders/:id/payments", auth, need("sell"), wrap(async (req, res) => {
    const o = await getOrder(num(req.params.id), req.user), b = req.body || {}, methods = await methodsOf();
    if (!["open", "ready"].includes(o.status)) bad("This order is finished.");
    const amount = money(b.amount); if (amount <= 0) bad("Enter the amount received.");
    if (amount > o.balance + 0.001) bad(`Only ${o.balance.toLocaleString("en-US")} RWF is left to pay on this order.`);
    if (!methods.includes(b.method)) bad("Choose how the customer paid.");
    await db.run("INSERT INTO payments (date, t, kind, method, amount, order_id, customer_id, user_id) VALUES (?,?,?,?,?,?,?,?)", localDate(), now(), "deposit", b.method, amount, o.id, o.customer_id, req.user.id);
    await audit(req, "order.payment", `${o.order_no}: ${amount} by ${b.method}`); res.json({ ok: true });
  }));

  app.post("/api/orders/:id/status", auth, need("sell"), wrap(async (req, res) => {
    const o = await getOrder(num(req.params.id), req.user), st = req.body.status;
    if (!["open", "ready"].includes(st)) bad("Unknown status.");
    if (!["open", "ready"].includes(o.status)) bad("This order is finished.");
    await db.run("UPDATE orders SET status = ? WHERE id = ?", st, o.id);
    await audit(req, "order." + st, o.order_no); res.json({ ok: true });
  }));

  // Customer collects: the order becomes a sale; deposits count as payment; the rest is paid now or put on credit.
  app.post("/api/orders/:id/collect", auth, need("sell"), wrap(async (req, res) => {
    const o = await getOrder(num(req.params.id), req.user), b = req.body || {};
    if (!["open", "ready"].includes(o.status)) bad("This order is already finished.");
    const { pays, credit } = parsePayments(b.payments, o.balance, await methodsOf());
    const sale = await db.tx(async (t) => {
      const fresh = await t.get("SELECT status FROM orders WHERE id = ?", o.id); if (!["open", "ready"].includes(fresh.status)) bad("This order is already finished.");
      const customer = { id: o.customer_id, name: o.customer };
      const lines = [{ p: { id: null, name: `${o.order_no}: ${o.description}`.slice(0, 120) }, qty: 1, price: o.total, cost: o.cost || 0, line: o.total }];
      const allPays = [...o.payments.filter((p) => !p.voided), ...pays];
      const sale = await insertSale(t, { date: localDate(), user: req.user, customer, lines, subtotal: o.total, discount: 0, pays, credit, note: `Order ${o.order_no}` });
      await t.run("UPDATE sales SET method = ? WHERE id = ?", methodLabel(allPays, credit), sale.id);
      await t.run("UPDATE payments SET sale_id = ? WHERE order_id = ? AND voided = 0", sale.id, o.id);
      await t.run("UPDATE orders SET status = 'collected', sale_id = ?, done_t = ?, done_by = ? WHERE id = ?", sale.id, now(), req.user.id, o.id);
      return sale;
    });
    await audit(req, "order.collected", `${o.order_no} → ${sale.receipt}${credit > 0.001 ? `, on credit ${credit}` : ""}`);
    res.json({ ok: true, sale: await getSale(sale.id, req.user) });
  }));

  app.post("/api/orders/:id/cancel", auth, need("sales.void"), wrap(async (req, res) => {
    const o = await getOrder(num(req.params.id), req.user), b = req.body || {};
    const reason = str(b.reason, 200); if (reason.length < 3) bad("Please write the reason.");
    if (!["open", "ready"].includes(o.status)) bad("This order is already finished.");
    const refund = b.refund && o.paid > 0;
    if (refund && !(await methodsOf()).includes(b.refund_method)) bad("Choose how the deposit is given back.");
    await db.tx(async (t) => {
      await t.run("UPDATE orders SET status = 'cancelled', done_t = ?, done_by = ?, cancel_reason = ? WHERE id = ?", now(), req.user.id, reason, o.id);
      if (refund) await t.run("INSERT INTO payments (date, t, kind, method, amount, order_id, customer_id, note, user_id) VALUES (?,?,?,?,?,?,?,?,?)",
        localDate(), now(), "refund", b.refund_method, -o.paid, o.id, o.customer_id, "Deposit given back: " + reason, req.user.id);
    });
    await audit(req, "order.cancelled", `${o.order_no}: ${reason}${o.paid ? (refund ? ` — deposit ${o.paid} given back` : ` — deposit ${o.paid} kept`) : ""}`);
    res.json({ ok: true });
  }));

  // ====================================================================
  // Close the day: expected money per method vs counted
  // ====================================================================
  async function dayMoney(d) {
    const methods = await methodsOf();
    const [recv, exp, closings] = await Promise.all([
      db.all("SELECT method, kind, SUM(amount) v, COUNT(*) n FROM payments WHERE voided = 0 AND date = ? GROUP BY method, kind", d),
      db.all("SELECT method, SUM(amount) v FROM expenses WHERE voided = 0 AND date = ? GROUP BY method", d),
      db.all("SELECT * FROM day_closings WHERE date = ? ORDER BY t DESC", d),
    ]);
    const cashName = methods.find((m) => /cash/i.test(m)) || methods[0];
    const all = [...new Set([...methods, ...recv.map((r) => r.method), ...exp.map((r) => r.method).filter(Boolean)])];
    const rows = all.map((m) => {
      const r = recv.filter((x) => x.method === m), kinds = {}; for (const x of r) kinds[x.kind] = money(x.v);
      const received = money(r.reduce((a, x) => a + x.v, 0)), paidOut = money(exp.find((x) => x.method === m)?.v || 0);
      return { method: m, is_cash: m === cashName, received, kinds, expenses: paidOut, expected: money(received - paidOut) };
    }).filter((r) => methods.includes(r.method) || r.received || r.expenses);
    for (const c of closings) c.lines = JSON.parse(c.lines || "[]");
    return { date: d, cash_method: cashName, rows, received: money(rows.reduce((a, r) => a + r.received, 0)), closing: closings[0] || null, history: closings };
  }
  app.get("/api/daybook/money", auth, need("daybook"), wrap(async (req, res) => res.json(await dayMoney(isDate(req.query.date) ? req.query.date : localDate()))));

  app.post("/api/daybook/close", auth, need("daybook"), wrap(async (req, res) => {
    const b = req.body || {}, d = isDate(b.date) ? b.date : localDate();
    if (d > localDate()) bad("You cannot close a day in the future.");
    const m = await dayMoney(d);
    if (m.closing && !can(req.user, "sales.void")) bad("This day is already closed. Only a manager can count it again.");
    const float = Math.max(0, money(b.float)), counted = b.counted || {};
    const lines = m.rows.map((r) => {
      const expected = money(r.expected + (r.is_cash ? float : 0));
      const c = counted[r.method]; const cnt = c === "" || c == null ? expected : money(c);
      if (cnt < 0) bad("Counted amounts cannot be negative.");
      return { method: r.method, expected, counted: cnt, difference: money(cnt - expected) };
    });
    const exp = money(lines.reduce((a, l) => a + l.expected, 0)), cnt = money(lines.reduce((a, l) => a + l.counted, 0)), diff = money(cnt - exp);
    if (Math.abs(diff) > 0.5 && str(b.note, 300).length < 3) bad("The count does not match. Please write a short note explaining the difference.");
    await db.run("INSERT INTO day_closings (date, t, user_id, float, lines, expected, counted, difference, note) VALUES (?,?,?,?,?,?,?,?,?)",
      d, now(), req.user.id, float, JSON.stringify(lines), exp, cnt, diff, str(b.note, 300));
    await audit(req, "day.closed", `${d}: expected ${exp}, counted ${cnt}, ${diff === 0 ? "matches" : diff < 0 ? "SHORT " + -diff : "over " + diff}`);
    res.json({ ok: true, ...(await dayMoney(d)) });
  }));

  // ====================================================================
  // Who is online, and what each person did
  // ====================================================================
  const ONLINE_MS = 10 * 60e3; // seen in the last 10 minutes
  app.get("/api/online", auth, need("users"), wrap(async (req, res) => {
    const rows = await db.all(`SELECT u.id, u.name, u.role, MAX(s.last_seen_t) seen, COUNT(*) devices, MAX(s.ip) ip FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.last_seen_t > ? GROUP BY u.id ORDER BY seen DESC`, now() - ONLINE_MS);
    res.json({ online: rows });
  }));

  // One person's activity on screen: totals plus every recorded action (newest first).
  app.get("/api/users/:id/activity", auth, wrap(async (req, res) => {
    const uid = num(req.params.id);
    if (uid !== req.user.id && !can(req.user, "users") && !can(req.user, "reports")) return res.status(403).json({ error: "You can only see your own activity." });
    const to = isDate(req.query.to) ? req.query.to : localDate(), from = isDate(req.query.from) ? req.query.from : to;
    const u = await db.get("SELECT id, name, username, role, status, last_login_t FROM users WHERE id = ?", uid); if (!u) bad("User not found.");
    const [sales, recv, exp, moves, orders, acts, sess] = await Promise.all([
      db.get("SELECT COUNT(*) n, COALESCE(SUM(total),0) v FROM sales WHERE user_id = ? AND voided = 0 AND date BETWEEN ? AND ?", uid, from, to),
      db.all("SELECT method, SUM(amount) v FROM payments WHERE user_id = ? AND voided = 0 AND date BETWEEN ? AND ? GROUP BY method ORDER BY v DESC", uid, from, to),
      db.get("SELECT COUNT(*) n, COALESCE(SUM(amount),0) v FROM expenses WHERE user_id = ? AND voided = 0 AND date BETWEEN ? AND ?", uid, from, to),
      db.get("SELECT COUNT(*) n FROM stock_moves WHERE user_id = ? AND voided = 0 AND date BETWEEN ? AND ?", uid, from, to),
      db.get("SELECT COUNT(*) n FROM orders WHERE user_id = ? AND date BETWEEN ? AND ?", uid, from, to),
      db.all("SELECT id, t, action, detail, ip FROM audit WHERE user_id = ? AND t BETWEEN ? AND ? ORDER BY t DESC LIMIT 1000", uid, dayStart(from), dayEnd(to)),
      db.get("SELECT MAX(last_seen_t) seen, COUNT(*) n FROM sessions WHERE user_id = ?", uid),
    ]);
    res.json({ user: u, from, to, online: !!sess.seen && now() - sess.seen < ONLINE_MS, last_seen_t: sess.seen || null,
      summary: { sales: sales.n, sales_total: sales.v, received: recv, expenses: exp.n, expenses_total: exp.v, stock_changes: moves.n, orders: orders.n,
        logins: acts.filter((a) => a.action === "login.ok").length, failed_logins: acts.filter((a) => a.action === "login.failed").length },
      actions: acts });
  }));

  return { dayMoney, statement, getOrder };
};
