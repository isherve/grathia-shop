// Grathia Shop Manager — browser app. All data comes from the server (/api/...).
"use strict";
(() => {
/* =================== helpers =================== */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : 0; };
const fmt = (n) => (n < 0 ? "−" : "") + Math.round(Math.abs(num(n))).toLocaleString("en-US");
const rwf = (n) => fmt(n) + " RWF";
const q = (n) => (+n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, "0");
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => dstr(new Date());
const shift = (s, n) => { const d = new Date(s + "T12:00"); d.setDate(d.getDate() + n); return dstr(d); };
const nice = (s) => { const d = new Date(String(s).length === 10 ? s + "T12:00" : s); return isNaN(d) ? s : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }); };
const short = (s) => { const d = new Date(s + "T12:00"); return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }); };
const tm = (t) => (t ? new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "");
const when = (t) => (t ? new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const ini = (n) => (String(n || "?").trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2) || "?").toUpperCase();
const ROLE = { admin: "Administrator", manager: "Manager", cashier: "Cashier" };
const opts = (arr, sel) => arr.map((x) => { const [v, l] = Array.isArray(x) ? x : [x, x]; return `<option value="${esc(v)}"${String(v) === String(sel) ? " selected" : ""}>${esc(l)}</option>`; }).join("");
function range(p) {
  const t = new Date(), T = today();
  if (p === "today") return [T, T];
  if (p === "yesterday") { const y = shift(T, -1); return [y, y]; }
  if (p === "week") { const s = new Date(t); s.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return [dstr(s), T]; }
  if (p === "month") return [T.slice(0, 8) + "01", T];
  if (p === "last") { const a = new Date(t.getFullYear(), t.getMonth() - 1, 1), b = new Date(t.getFullYear(), t.getMonth(), 0); return [dstr(a), dstr(b)]; }
  if (p === "30") return [shift(T, -29), T];
  if (p === "year") return [T.slice(0, 4) + "-01-01", T];
  return [T, T];
}
const PRESETS = [["today", "Today"], ["yesterday", "Yesterday"], ["week", "This week"], ["month", "This month"], ["last", "Last month"]];
function rangeBar(id, preset, extra = "") {
  const [a, b] = range(preset);
  return `<div class="toolbar" id="${id}"><div class="chips">${PRESETS.map(([k, l]) => `<button data-p="${k}" aria-pressed="${k === preset}">${l}</button>`).join("")}</div>
  <label class="fl">From<input type="date" data-r="from" value="${a}"></label><label class="fl">To<input type="date" data-r="to" value="${b}"></label>${extra}</div>`;
}
function bindRange(id, cb) {
  const bar = $(id), f = bar.querySelector("[data-r=from]"), t = bar.querySelector("[data-r=to]");
  bar.querySelector(".chips").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return;
    for (const c of bar.querySelectorAll(".chips button")) c.setAttribute("aria-pressed", c === b);
    [f.value, t.value] = range(b.dataset.p); cb(f.value, t.value); });
  for (const i of [f, t]) i.addEventListener("change", () => { for (const c of bar.querySelectorAll(".chips button")) c.setAttribute("aria-pressed", false); if (f.value && t.value) cb(f.value, t.value); });
  return () => [f.value, t.value];
}

/* =================== state & server =================== */
const S = { user: null, perms: [], shop: {}, boot: null, route: "", cart: [], pos: { method: "", customer: "", customer_id: null, discount: 0, ref: "" }, renderId: 0 };
const can = (p) => S.perms.includes(p);
async function api(path, { method = "GET", body } = {}) {
  let r;
  try { r = await fetch(path, { method, credentials: "same-origin", headers: { "X-Requested-With": "GrathiaApp", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
  catch (e) { throw new Error("Can't reach the server. Is it running?"); }
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (r.status === 401 && S.user) { sessionEnded("Your session has ended. Please log in again."); throw new Error("Please log in."); }
  if (r.status === 403 && j.code === "must_change") { showAuth("must_change"); throw new Error(j.error); }
  if (!r.ok) throw new Error(j.error || "Something went wrong.");
  return j;
}
async function refreshBoot() { S.boot = await api("/api/bootstrap"); }
const prodById = (id) => (S.boot?.products || []).find((p) => p.id === Number(id));

/* =================== toast & modal =================== */
function toast(t) { const e = $("toast"); e.textContent = t; e.classList.add("on"); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove("on"), 2800); }
function modal({ title, body, foot = "", wide = false, onMount }) {
  const m = $("mbox"); m.className = "mbox" + (wide ? " wide" : "");
  m.innerHTML = `<div class="mh"><h3>${title}</h3><button class="ib" data-close aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div><div class="mb">${body}</div>${foot ? `<div class="mf">${foot}</div>` : ""}`;
  $("modal").classList.add("on"); onMount && onMount(m);
  const f = m.querySelector(".mb input:not([type=hidden]):not([readonly]),.mb select,.mb textarea"); if (f) f.focus();
}
function closeModal() { $("modal").classList.remove("on"); $("mbox").innerHTML = ""; }
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal" || e.target.closest("[data-close]")) closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
function formModal({ title, fields, submit = "Save", danger = false, onSubmit, wide, note = "" }) {
  modal({ title, wide, body: `<form id="mf" class="grid2" novalidate>${fields}</form>${note}<p class="err" id="merr"></p>`,
    foot: `<button class="btn alt" data-close type="button">Cancel</button><button class="btn${danger ? " red" : ""}" id="msub" type="button">${submit}</button>`,
    onMount: () => {
      const go = async () => { const f = $("mf"); if (!f.reportValidity()) return; const b = $("msub"); b.disabled = true; $("merr").textContent = "";
        try { await onSubmit(Object.fromEntries(new FormData(f)), f); } catch (e) { $("merr").textContent = e.message; b.disabled = false; } };
      $("msub").addEventListener("click", go); $("mf").addEventListener("submit", (e) => { e.preventDefault(); go(); });
    } });
}
const fld = (label, inner, wide) => `<label class="fl${wide ? " w" : ""}">${label}${inner}</label>`;

/* =================== icons =================== */
const IC = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  cart: '<path d="M3 4h2l2.4 11h11.2L21 7H6.2"/><circle cx="9" cy="19.5" r="1.5"/><circle cx="17" cy="19.5" r="1.5"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>',
  box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
  wallet: '<path d="M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 7l12-4v4"/><circle cx="16.5" cy="13.5" r="1.3"/>',
  book: '<path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a3 3 0 0 0-3 3"/><path d="M20 4v14h-6"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  log: '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  out: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  down: '<path d="M12 4v12M6 11l6 6 6-6M4 20h16"/>',
  print: '<path d="M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z"/>',
  in: '<path d="M12 3v12M7 10l5 5 5-5M4 21h16"/>',
  minus: '<path d="M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  xls: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 12l5 5M14 12l-5 5"/>',
  pdf: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  adduser: '<circle cx="10" cy="8" r="4"/><path d="M2.5 21a7.5 7.5 0 0 1 15 0M19 8v6M16 11h6"/>',
};
const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${IC[n] || ""}</svg>`;

/* =================== Excel / PDF download buttons =================== */
const expBtns = (id) => `<span class="exp" id="${id}"><a class="btn alt" data-f="xlsx" href="#" title="Download as Excel">${icon("xls")}Excel</a><a class="btn alt" data-f="pdf" href="#" title="Download as PDF">${icon("pdf")}PDF</a></span>`;
function setExp(id, section, params = {}) {
  const box = $(id); if (!box) return; const qs = new URLSearchParams(params).toString();
  for (const x of box.querySelectorAll("a")) x.href = `/api/export/${section}.${x.dataset.f}${qs ? "?" + qs : ""}`;
}

// "Recorded by" filter: shows one person's records; the Excel/PDF buttons follow it.
const staffSel = (id) => `<label class="fl">Recorded by<select id="${id}"><option value="">Everyone</option>${opts(Object.entries(S.boot?.names || {}).sort((x, y) => x[1].localeCompare(y[1])))}</select></label>`;
const withUser = (p, sel) => { const u = $(sel)?.value; return u ? { ...p, user: u } : p; };
function activityModal(uid, name) {
  modal({ title: `Download activity — ${esc(name)}`, body: `<p style="margin-top:0">Everything ${esc(name)} recorded in the period: sales, expenses, stock changes and every action in the system — without downloading the whole report.</p>` +
      rangeBar("acr", "month") + `<div class="toolbar">${expBtns("acx")}</div>`,
    onMount: () => { const set = (f, t) => setExp("acx", "activity", { from: f, to: t, user: uid }); const get = bindRange("acr", set); set(...get()); } });
}

/* =================== theme =================== */
function paintTheme() { const d = document.documentElement.dataset.theme === "dark"; $("theme").innerHTML = icon(d ? "sun" : "moon"); $("theme").setAttribute("aria-label", d ? "Switch to light mode" : "Switch to dark mode"); }
$("theme").addEventListener("click", () => { const r = document.documentElement; r.dataset.theme = r.dataset.theme === "dark" ? "light" : "dark"; try { localStorage.setItem("gr-theme", r.dataset.theme); } catch (e) {} paintTheme(); if (S.route) go(S.route, true); });
paintTheme();

/* =================== routes & sidebar =================== */
const ROUTES = [
  { id: "dashboard", label: "Dashboard", group: "Main", icon: "home", perm: null },
  { id: "pos", label: "New sale", group: "Main", icon: "cart", perm: "sell" },
  { id: "sales", label: "Sales & receipts", group: "Main", icon: "receipt", perm: "sales.view" },
  { id: "items", label: "Items", group: "Stock", icon: "tag", perm: "stock.view" },
  { id: "inventory", label: "Inventory", group: "Stock", icon: "box", perm: "stock.view" },
  { id: "expenses", label: "Expenses", group: "Money", icon: "wallet", perm: "expense.view" },
  { id: "daybook", label: "Day book", group: "Money", icon: "book", perm: "daybook" },
  { id: "reports", label: "Reports", group: "Money", icon: "chart", perm: "reports" },
  { id: "customers", label: "Customers", group: "People", icon: "users", perm: "customers" },
  { id: "users", label: "Users & roles", group: "Administration", icon: "shield", perm: "users" },
  { id: "audit", label: "Audit log", group: "Administration", icon: "log", perm: "audit" },
  { id: "settings", label: "Settings & backup", group: "Administration", icon: "gear", perm: "settings" },
  { id: "account", label: "My account", group: "", icon: "user", perm: null, foot: true },
];
let pendingUsers = 0;
function buildNav() {
  const vis = ROUTES.filter((r) => !r.perm || can(r.perm));
  let html = "", g = null;
  for (const r of vis.filter((r) => !r.foot)) {
    if (r.group !== g) { g = r.group; html += `<div class="navg">${esc(g)}</div>`; }
    html += `<a href="#/${r.id}" data-r="${r.id}">${icon(r.icon)}<span>${esc(r.label)}</span>${r.id === "users" && pendingUsers ? `<span class="badge">${pendingUsers}</span>` : ""}</a>`;
  }
  $("nav").innerHTML = html;
  $("nav2").innerHTML = `<a href="#/account" data-r="account">${icon("user")}<span>My account</span></a><a href="#" id="logout">${icon("out")}<span>Log out</span></a>`;
  for (const a of document.querySelectorAll(".nav a[data-r]")) a.setAttribute("aria-current", a.dataset.r === S.route ? "page" : "false");
  $("me-av").textContent = ini(S.user.name); $("me-name").textContent = S.user.name; $("me-role").textContent = ROLE[S.user.role] || S.user.role;
  $("shopname").textContent = S.shop.name || "Grathia Sweet Haven";
}
$("menu").addEventListener("click", () => document.body.classList.toggle("nav-open"));
$("scrim").addEventListener("click", () => document.body.classList.remove("nav-open"));
document.addEventListener("click", (e) => { if (e.target.closest("#logout")) { e.preventDefault(); logout(); } if (e.target.closest(".nav a[data-r]")) document.body.classList.remove("nav-open"); });
window.addEventListener("hashchange", () => { const r = location.hash.replace(/^#\/?/, ""); if (S.user && r !== S.route) go(r); });

async function go(id, keepScroll) {
  const r = ROUTES.find((x) => x.id === id && (!x.perm || can(x.perm))) || ROUTES[0];
  S.route = r.id; if (location.hash !== "#/" + r.id) history.replaceState(null, "", "#/" + r.id);
  $("title").textContent = r.label; document.title = r.label + " · Grathia Shop Manager";
  for (const a of document.querySelectorAll(".nav a[data-r]")) a.setAttribute("aria-current", a.dataset.r === r.id ? "page" : "false");
  const el = $("page"), my = ++S.renderId;
  if (!keepScroll) { el.innerHTML = `<div class="empty">Loading…</div>`; window.scrollTo(0, 0); }
  try { await PAGES[r.id](el, () => my === S.renderId); }
  catch (e) { if (my === S.renderId) el.innerHTML = `<div class="card"><div class="empty">${esc(e.message)}</div></div>`; }
}
const reload = () => go(S.route, true);

/* =================== charts (drawn as SVG) =================== */
function barChart(host, data, { series2 = false, color2 = "var(--cor)" } = {}) {
  const draw = () => {
    const W = host.clientWidth, H = host.clientHeight; if (!W) return;
    const L = 56, B = 26, T = 10, R = 8, iw = W - L - R, ih = H - B - T;
    const max = Math.max(1, ...data.map((d) => Math.max(d.v, d.v2 || 0)));
    const step = Math.pow(10, Math.floor(Math.log10(max))), nice = Math.ceil(max / step) * step;
    const bw = iw / data.length, gap = Math.min(10, bw * 0.25), w = series2 ? (bw - gap) / 2 : bw - gap;
    let s = "";
    for (let i = 0; i <= 4; i++) { const y = T + ih - (ih * i) / 4, v = (nice * i) / 4;
      s += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="var(--line)"/><text x="${L - 8}" y="${y + 4}" text-anchor="end">${v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? Math.round(v / 1e3) + "k" : Math.round(v)}</text>`; }
    const every = Math.ceil(data.length / Math.max(1, Math.floor(iw / 48)));
    data.forEach((d, i) => {
      const x = L + i * bw + gap / 2, h = (d.v / nice) * ih;
      s += `<rect x="${x}" y="${T + ih - h}" width="${Math.max(1, w)}" height="${h}" rx="3" fill="var(--pri)"><title>${esc(d.label)}: ${rwf(d.v)}</title></rect>`;
      if (series2) { const h2 = ((d.v2 || 0) / nice) * ih; s += `<rect x="${x + w}" y="${T + ih - h2}" width="${Math.max(1, w)}" height="${h2}" rx="3" fill="${color2}"><title>${esc(d.label)}: ${rwf(d.v2 || 0)}</title></rect>`; }
      if (i % every === 0) s += `<text x="${L + i * bw + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
    });
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart">${s}</svg>`;
  };
  draw(); const ro = new ResizeObserver(draw); ro.observe(host);
}
const bars = (rows, color = "var(--pri)", fmtv = rwf) => { const mx = Math.max(1, ...rows.map((r) => r.v));
  return rows.length ? `<div class="list">${rows.map((r) => `<div class="row"><div class="m"><b>${esc(r.name)}</b><div class="hb" style="width:${((r.v / mx) * 100).toFixed(1)}%;background:${color}"></div></div><div class="v">${fmtv(r.v)}${r.n != null ? `<br><small>${q(r.n)} ${r.n === 1 ? "receipt" : "receipts"}</small>` : ""}</div></div>`).join("")}</div>` : `<div class="empty">Nothing in this period.</div>`; };

/* =================== receipt =================== */
function receiptHTML(s) {
  const names = S.boot?.names || {};
  return `<div class="receipt"><img src="brand/logo-192.png" alt="" class="logo"><h4>${esc(S.shop.name)}</h4><div class="c">${esc(S.shop.tagline || "")}<br>${esc(S.shop.address || "")}<br>${esc(S.shop.phone || "")}</div><hr>
  ${s.voided ? `<div class="void">CANCELLED — ${esc(s.void_reason || "")}</div>` : ""}
  <div>Receipt: <b>${esc(s.receipt_no)}</b><br>Date: ${esc(nice(s.date))} ${tm(s.t)}<br>Cashier: ${esc(names[s.user_id] || "—")}${s.customer ? `<br>Customer: ${esc(s.customer)}` : ""}</div><hr>
  <table><tbody>${s.items.map((i) => `<tr><td colspan="2">${esc(i.name)}</td></tr><tr><td>${q(i.qty)} × ${fmt(i.price)}</td><td class="n">${fmt(i.line_total)}</td></tr>`).join("")}</tbody></table><hr>
  <table><tbody><tr><td>Subtotal</td><td class="n">${fmt(s.subtotal)}</td></tr>${s.discount ? `<tr><td>Discount</td><td class="n">−${fmt(s.discount)}</td></tr>` : ""}
  <tr><td><b>TOTAL (${esc(S.shop.currency || "RWF")})</b></td><td class="n"><b>${fmt(s.total)}</b></td></tr><tr><td>Paid by</td><td class="n">${esc(s.method)}</td></tr></tbody></table><hr>
  <div class="c">${esc(S.shop.footer || "")}</div></div>`;
}
function printHTML(html) { $("print-area").innerHTML = html; window.print(); }
function showReceipt(s, after) {
  modal({ title: `Receipt ${esc(s.receipt_no)}`, body: receiptHTML(s) + (s.voided ? `<p class="hint" style="text-align:center">Cancelled by ${esc(S.boot.names[s.void_by] || "—")} on ${esc(when(s.void_t))}</p>` : ""),
    foot: `${!s.voided && can("sales.void") ? `<button class="btn red" id="rvoid">Cancel sale</button><span style="flex:1"></span>` : ""}<button class="btn alt" data-close>Close</button><a class="btn alt" href="/api/sales/${s.id}/receipt.pdf" target="_blank" rel="noopener">${icon("pdf")}PDF</a><button class="btn" id="rprint">${icon("print")}Print</button>`,
    onMount: () => {
      $("rprint").addEventListener("click", () => printHTML(receiptHTML(s)));
      const v = $("rvoid"); if (v) v.addEventListener("click", () => formModal({ title: `Cancel sale ${esc(s.receipt_no)}`, danger: true, submit: "Cancel this sale",
        fields: fld("Reason (required, saved in the audit log)", `<input name="reason" required minlength="3" maxlength="200">`, true),
        note: `<p class="hint">The sale stays in the records marked CANCELLED. Its money and items are removed from totals and stock.</p>`,
        onSubmit: async (v) => { await api(`/api/sales/${s.id}/void`, { method: "POST", body: v }); closeModal(); toast("Sale cancelled"); await refreshBoot(); after ? after() : reload(); } }));
    } });
}

/* =================== pages =================== */
const PAGES = {};

/* ---------- Dashboard ---------- */
PAGES.dashboard = async (el, alive) => {
  const d = await api("/api/dashboard"); if (!alive()) return;
  const k = [["Today's sales", rwf(d.today.sales), `${d.today.receipts} receipt${d.today.receipts === 1 ? "" : "s"}`, ""], ["Today's expenses", rwf(d.today.expenses), "", ""],
    ["This month's sales", rwf(d.month.sales), "", ""], d.month.profit != null ? ["This month's profit", rwf(d.month.profit), "after costs & expenses", d.month.profit >= 0 ? "g" : "r"] : ["Items running low", String(d.low.length), "", d.low.length ? "r" : ""]];
  el.innerHTML = `<div class="qa">${can("sell") ? `<a class="btn lg" href="#/pos">${icon("cart")}New sale</a>` : ""}${can("stock.in") ? `<button class="btn lg alt" id="q-in">${icon("in")}Receive stock</button>` : ""}${can("expense.add") ? `<button class="btn lg alt" id="q-exp">${icon("wallet")}Add expense</button>` : ""}</div>
  <div class="kpis">${k.map(([a, b, c, cl]) => `<div class="card kpi ${cl}"><p>${a}</p><strong>${b}</strong><small>${c}</small></div>`).join("")}</div>
  <div class="cols"><div class="card fill"><div class="hd"><h2>Sales — last 14 days</h2></div><div class="chart" id="ch"></div></div>
    <div class="card"><div class="hd"><h2>Running low</h2><span class="sp"></span><a href="#/inventory" class="btn sm alt">Inventory</a></div>
    ${d.low.length ? `<div class="list">${d.low.map((p) => `<div class="row"><div class="m"><b>${esc(p.name)}</b><small>Reorder at ${q(p.reorder)} ${esc(p.unit)}</small></div><div class="v ${p.on_hand <= 0 ? "bad" : "warn"}">${q(p.on_hand)} left</div></div>`).join("")}</div>` : `<div class="empty">All stock levels are fine.</div>`}</div></div>
  <div class="cols even"><div class="card"><div class="hd"><h2>Best sellers — last 30 days</h2></div>${bars(d.top.map((t) => ({ name: `${t.name} (${q(t.q)})`, v: t.v })))}</div>
    <div class="card"><div class="hd"><h2>Latest receipts</h2><span class="sp"></span>${can("sales.view") ? `<a href="#/sales" class="btn sm alt">All sales</a>` : ""}</div>
    ${d.recent.length ? `<div class="list">${d.recent.map((r) => `<div class="row"><div class="m"><b>${esc(r.receipt_no)}${r.customer ? " · " + esc(r.customer) : ""}</b><small>${esc(when(r.t))} · ${esc(r.method)} · ${esc(S.boot.names[r.user_id] || "—")}</small></div><div class="v ok">${rwf(r.total)}</div></div>`).join("")}</div>` : `<div class="empty">No sales yet.</div>`}</div></div>`;
  barChart($("ch"), d.days.map((x) => ({ label: short(x.date), v: x.sales })));
  $("q-in")?.addEventListener("click", () => moveModal("in", null, reload));
  $("q-exp")?.addEventListener("click", () => expenseModal(reload));
};

/* ---------- Point of sale ---------- */
PAGES.pos = async (el) => {
  await refreshBoot();
  const L = S.boot.lists; if (!S.pos.method || !L.payment_methods.includes(S.pos.method)) S.pos.method = L.payment_methods[0];
  const sellable = S.boot.products.filter((p) => !p.archived && p.sellable);
  const cats = [...new Set(sellable.map((p) => p.category))];
  let cat = "all", search = "";
  el.innerHTML = `<div class="pos"><div class="card"><div class="hd"><input id="ps" placeholder="Search items… (Enter adds the first match)" autocomplete="off">${S.boot.allow_custom ? `<button class="btn alt" id="pcustom" title="Sell something that is not in the item list">${icon("plus")}Custom item</button>` : ""}</div>
    <div class="bd"><div class="chips" id="pc" style="margin-bottom:12px"><button data-c="all" aria-pressed="true">All</button>${cats.map((c) => `<button data-c="${esc(c)}" aria-pressed="false">${esc(c)}</button>`).join("")}</div><div class="items" id="pi"></div></div></div>
    <div class="card cart"><div class="hd"><h2>Current sale</h2><span class="sp"></span><button class="btn sm ghost" id="pclear">Clear</button></div><div id="plines"></div>
    <div class="bd" style="border-top:1px solid var(--line);display:grid;gap:10px">
      <label class="fl">Customer (optional)<input id="pcust" list="custlist" value="${esc(S.pos.customer)}" placeholder="Walk-in customer"><datalist id="custlist">${S.boot.customers.map((c) => `<option value="${esc(c.name)}">${esc(c.phone)}</option>`).join("")}</datalist></label>
      <div class="grid2"><label class="fl">Referred by<input id="pref" value="${esc(S.pos.ref)}"></label><label class="fl">Discount (RWF)<input id="pdisc" inputmode="numeric" value="${S.pos.discount || ""}" placeholder="0"></label></div>
      <div><div class="hint" style="margin-bottom:6px">Paid by</div><div class="paym" id="ppay">${L.payment_methods.map((m) => `<button data-m="${esc(m)}" aria-pressed="${m === S.pos.method}">${esc(m)}</button>`).join("")}</div></div></div>
    <div id="ptot"></div><div class="bd"><button class="btn lg" id="pdone" style="width:100%">Complete sale</button><p class="err" id="perr"></p></div></div></div>`;
  const drawItems = () => {
    const s = search.toLowerCase(), list = sellable.filter((p) => (cat === "all" || p.category === cat) && (!s || p.name.toLowerCase().includes(s) || String(p.sku).toLowerCase().includes(s)));
    $("pi").innerHTML = list.length ? list.map((p) => `<button class="it${p.on_hand <= 0 ? " out" : ""}" data-id="${p.id}"><b>${esc(p.name)}</b><small>${esc(p.sku || "")} · ${q(p.on_hand)} ${esc(p.unit)} in stock</small><span class="p">${rwf(p.price)}</span></button>`).join("") : `<div class="empty" style="grid-column:1/-1">No items found.${can("items.manage") ? ` <a href="#/items">Add items</a>` : ""}</div>`;
    return list;
  };
  const drawCart = () => {
    const sub = S.cart.reduce((a, l) => a + l.qty * l.price, 0), disc = Math.min(num(S.pos.discount), sub);
    $("plines").innerHTML = S.cart.length ? S.cart.map((l, i) => { const p = prodById(l.id), over = p && l.qty > p.on_hand;
      return `<div class="cl"><div><b>${esc(l.name)}</b>${l.custom ? `<span class="tag custom">custom</span>` : ""}<br><small>${can("price.override") || l.custom ? `<input data-pr="${i}" value="${l.price}" inputmode="numeric" style="width:96px;min-height:30px;padding:3px 6px">` : rwf(l.price)} each${over ? ` · <span class="warn">only ${q(p.on_hand)} in stock</span>` : ""}</small></div>
      <div class="qty"><button data-dec="${i}" aria-label="Less">−</button><input data-q="${i}" value="${l.qty}" inputmode="decimal" aria-label="Quantity"><button data-inc="${i}" aria-label="More">+</button></div><b class="n" style="min-width:74px;text-align:end">${fmt(l.qty * l.price)}</b></div>`; }).join("") : `<div class="empty">Tap items to add them to this sale.</div>`;
    $("ptot").innerHTML = `<div style="border-top:1px solid var(--line);padding-top:6px"><div class="tot-row"><span>Subtotal</span><span>${rwf(sub)}</span></div>${disc ? `<div class="tot-row"><span>Discount</span><span>−${rwf(disc)}</span></div>` : ""}<div class="tot-row big"><span>Total</span><span>${rwf(sub - disc)}</span></div></div>`;
    $("pdone").disabled = !S.cart.length;
  };
  const add = (id) => { const p = prodById(id); if (!p) return; const l = S.cart.find((x) => x.id === p.id); if (l) l.qty++; else S.cart.push({ id: p.id, name: p.name, price: p.price, qty: 1 }); drawCart(); };
  $("pi").addEventListener("click", (e) => { const b = e.target.closest("[data-id]"); if (b) add(b.dataset.id); });
  $("ps").addEventListener("input", (e) => { search = e.target.value; drawItems(); });
  $("ps").addEventListener("keydown", (e) => { if (e.key === "Enter") { const l = drawItems(); if (l[0]) { add(l[0].id); e.target.value = ""; search = ""; drawItems(); } } });
  $("pc").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; cat = b.dataset.c; for (const c of $("pc").children) c.setAttribute("aria-pressed", c === b); drawItems(); });
  $("plines").addEventListener("click", (e) => { const t = e.target; const i = +(t.dataset.dec ?? t.dataset.inc ?? -1); if (i < 0) return;
    S.cart[i].qty = Math.max(0, num(S.cart[i].qty) + (t.dataset.inc != null ? 1 : -1)); if (!S.cart[i].qty) S.cart.splice(i, 1); drawCart(); });
  $("plines").addEventListener("change", (e) => { const t = e.target;
    if (t.dataset.q != null) { const i = +t.dataset.q, v = num(t.value); if (v <= 0) S.cart.splice(i, 1); else S.cart[i].qty = v; drawCart(); }
    if (t.dataset.pr != null) { S.cart[+t.dataset.pr].price = Math.max(0, num(t.value)); drawCart(); } });
  $("pcustom")?.addEventListener("click", () => {
    const M = can("items.manage");
    formModal({ title: "Add a custom item to this sale", submit: "Add to sale",
      fields: fld("What is it?", `<input name="name" required maxlength="80" placeholder="e.g. Special order: 3-tier wedding cake">`, true) +
        fld("Price each (RWF)", `<input name="price" inputmode="numeric" required>`) + fld("Quantity", `<input name="qty" inputmode="decimal" value="1" required>`) +
        (can("costs.view") ? fld("Cost each (RWF) — optional, for profit reports", `<input name="cost" inputmode="numeric" placeholder="0">`, true) : "") +
        (M ? `<label class="w" style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" name="save" value="1" id="csave" style="width:20px;min-height:20px"> Also save it to the item list (so it can be sold and stocked again)</label>` +
          `<label class="fl w" id="ccatw" hidden>Category<input name="category" list="ccatl" value="${esc(S.boot.lists.categories[0] || "")}"><datalist id="ccatl">${S.boot.lists.categories.map((c) => `<option value="${esc(c)}">`).join("")}</datalist></label>` : ""),
      note: `<p class="hint">A custom item is sold only on this receipt. It does not change stock levels. It is recorded in the audit log.</p>`,
      onSubmit: async (v) => {
        const price = num(v.price), qty = num(v.qty); if (!v.name.trim()) throw new Error("Give the item a name."); if (price < 0) throw new Error("Check the price."); if (qty <= 0) throw new Error("Check the quantity.");
        if (v.save === "1") {
          await api("/api/items", { method: "POST", body: { name: v.name, price, cost: num(v.cost), category: v.category || "Other", unit: "Piece", reorder: 0, opening: 0, sellable: true } });
          await refreshBoot(); const p = S.boot.products.find((x) => x.name.toLowerCase() === v.name.trim().toLowerCase());
          if (p) S.cart.push({ id: p.id, name: p.name, price: p.price, qty }); closeModal(); toast("Saved to the item list and added to the sale"); go("pos", true); return;
        }
        S.cart.push({ id: "c" + Date.now(), custom: true, name: v.name.trim(), price, qty, cost: num(v.cost) }); closeModal(); drawCart(); toast("Custom item added");
      } });
    const cs = $("csave"); if (cs) cs.addEventListener("change", () => { $("ccatw").hidden = !cs.checked; });
  });
  $("pclear").addEventListener("click", () => { S.cart = []; S.pos.discount = 0; $("pdisc").value = ""; drawCart(); });
  $("pdisc").addEventListener("input", (e) => { S.pos.discount = num(e.target.value); drawCart(); });
  $("pcust").addEventListener("input", (e) => { S.pos.customer = e.target.value; });
  $("pref").addEventListener("input", (e) => { S.pos.ref = e.target.value; });
  $("ppay").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; S.pos.method = b.dataset.m; for (const c of $("ppay").children) c.setAttribute("aria-pressed", c === b); });
  $("pdone").addEventListener("click", async () => {
    const b = $("pdone"); b.disabled = true; $("perr").textContent = "";
    const c = S.boot.customers.find((x) => x.name.toLowerCase() === S.pos.customer.trim().toLowerCase());
    try {
      const r = await api("/api/sales", { method: "POST", body: { items: S.cart.map((l) => (l.custom ? { custom: true, name: l.name, qty: l.qty, price: l.price, cost: l.cost || 0 } : { product_id: l.id, qty: l.qty, ...(can("price.override") ? { price: l.price } : {}) })),
        discount: num(S.pos.discount), method: S.pos.method, customer: S.pos.customer, customer_id: c?.id, referred_by: S.pos.ref } });
      S.cart = []; S.pos = { method: S.pos.method, customer: "", customer_id: null, discount: 0, ref: "" };
      await refreshBoot(); toast(`Sale saved — ${r.sale.receipt_no}`); showReceipt(r.sale, () => go("pos")); go("pos", true);
    } catch (e) { $("perr").textContent = e.message; b.disabled = false; }
  });
  drawItems(); drawCart(); $("ps").focus();
};

/* ---------- Sales & receipts ---------- */
PAGES.sales = async (el, alive) => {
  el.innerHTML = rangeBar("sr", "today", `${staffSel("su")}<label class="fl grow">Search<input id="ss" placeholder="Receipt number, customer or item"></label>${expBtns("sx")}`) + `<div id="sb"></div>`;
  let data = [];
  const draw = () => {
    const s = $("ss").value.trim().toLowerCase();
    const rows = data.filter((x) => !s || x.receipt_no.toLowerCase().includes(s) || (x.customer || "").toLowerCase().includes(s) || x.items.some((i) => i.name.toLowerCase().includes(s)));
    const ok = rows.filter((x) => !x.voided), tot = ok.reduce((a, x) => a + x.total, 0);
    $("sb").innerHTML = `<div class="kpis"><div class="card kpi"><p>Receipts</p><strong>${ok.length}</strong></div><div class="card kpi"><p>Total sales</p><strong>${rwf(tot)}</strong></div><div class="card kpi"><p>Average receipt</p><strong>${rwf(ok.length ? tot / ok.length : 0)}</strong></div><div class="card kpi ${rows.length - ok.length ? "r" : ""}"><p>Cancelled</p><strong>${rows.length - ok.length}</strong></div></div>
    <div class="card tw"><table><thead><tr><th>Receipt</th><th>Date & time</th><th>Customer</th><th>Items</th><th>Paid by</th><th>Cashier</th><th class="n">Total</th><th>Status</th></tr></thead><tbody>
    ${rows.length ? rows.map((x, i) => `<tr class="click" data-i="${data.indexOf(x)}"><td><b>${esc(x.receipt_no)}</b></td><td>${esc(short(x.date))} ${tm(x.t)}</td><td>${esc(x.customer || "—")}</td><td>${esc(x.items.map((i) => `${q(i.qty)}× ${i.name}`).join(", "))}</td><td>${esc(x.method)}</td><td>${esc(S.boot.names[x.user_id] || "—")}</td><td class="n${x.voided ? " strike" : ""}"><b>${rwf(x.total)}</b></td><td>${x.voided ? `<span class="tag t-cor">Cancelled</span>` : `<span class="tag t-pri">Paid</span>`}</td></tr>`).join("") : `<tr><td colspan="8" class="empty">No sales in this period.</td></tr>`}</tbody></table></div>`;
  };
  const load = async (a, b) => { const p = withUser({ from: a, to: b }, "su"); setExp("sx", "sales", p); await refreshBoot(); data = (await api(`/api/sales?${new URLSearchParams(p)}`)).sales; if (alive()) draw(); };
  const get = bindRange("sr", load); $("ss").addEventListener("input", draw); $("su").addEventListener("change", () => load(...get()));
  $("sb").addEventListener("click", (e) => { const r = e.target.closest("tr[data-i]"); if (r) showReceipt(data[+r.dataset.i], () => load(...get())); });
  await load(...get());
};

/* ---------- Items ---------- */
const UNITS = ["Piece", "Cup", "Cake", "Kg", "Gram", "Litre", "Pack", "Bottle", "Box", "Tray", "Dozen"];
function itemModal(p, after) {
  const L = S.boot.lists, isNew = !p; p = p || { sellable: true, unit: "Piece", category: L.categories[0] };
  formModal({ title: isNew ? "Add item" : `Edit ${esc(p.name)}`, submit: isNew ? "Add item" : "Save changes",
    fields: fld("Item name", `<input name="name" required maxlength="80" value="${esc(p.name || "")}" placeholder="e.g. Birthday cake medium">`, true) +
      fld("Item code (SKU)", `<input name="sku" maxlength="30" value="${esc(p.sku || "")}" placeholder="Automatic if empty">`) +
      fld("Category", `<input name="category" list="catl" required value="${esc(p.category || "")}"><datalist id="catl">${L.categories.map((c) => `<option value="${esc(c)}">`).join("")}</datalist>`) +
      fld("Unit", `<input name="unit" list="unitl" value="${esc(p.unit)}"><datalist id="unitl">${UNITS.map((u) => `<option value="${u}">`).join("")}</datalist>`) +
      fld("Selling price (RWF)", `<input name="price" inputmode="numeric" value="${p.price ?? ""}" placeholder="0">`) +
      fld("Cost price (RWF)", `<input name="cost" inputmode="numeric" value="${p.cost ?? ""}" placeholder="What it costs you">`) +
      fld("Reorder level", `<input name="reorder" inputmode="decimal" value="${p.reorder ?? 0}">`) +
      (isNew ? fld("Opening stock (how many you have now)", `<input name="opening" inputmode="decimal" value="0">`) : "") +
      `<label class="w" style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" name="sellable" value="1" ${p.sellable ? "checked" : ""} style="width:20px;min-height:20px"> Sold to customers (untick for ingredients used in the kitchen)</label>`,
    onSubmit: async (v) => { v.sellable = v.sellable === "1"; await api(isNew ? "/api/items" : `/api/items/${p.id}`, { method: isNew ? "POST" : "PUT", body: v }); closeModal(); toast(isNew ? "Item added" : "Item saved"); await refreshBoot(); after(); } });
}
const stTag = (p) => p.status === "low" ? `<span class="tag t-cor">Low</span>` : p.status === "check" ? `<span class="tag t-amb">Check count</span>` : p.status === "none" ? `<span class="tag t-mute">Made to order</span>` : `<span class="tag t-pri">OK</span>`;
PAGES.items = async (el, alive) => {
  await refreshBoot(); if (!alive()) return;
  const M = can("items.manage"), C = can("costs.view");
  el.innerHTML = `<div class="toolbar"><label class="fl grow">Search<input id="is" placeholder="Name or code"></label><label class="fl">Category<select id="ic"><option value="">All categories</option>${opts([...new Set(S.boot.products.map((p) => p.category))])}</select></label>
    <label class="fl" style="flex-direction:row;display:flex;gap:8px;align-items:center;min-height:42px"><input type="checkbox" id="ia" style="width:18px;min-height:18px">Show removed</label>${expBtns("ix")}${M ? `<button class="btn" id="iadd">${icon("plus")}Add item</button>` : ""}</div><div class="card tw" id="it"></div>
    ${M ? "" : `<p class="hint">Only managers and administrators can add or change items.</p>`}`;
  const draw = () => {
    const s = $("is").value.toLowerCase(), c = $("ic").value, a = $("ia").checked;
    const rows = S.boot.products.filter((p) => (a || !p.archived) && (!c || p.category === c) && (!s || p.name.toLowerCase().includes(s) || String(p.sku).toLowerCase().includes(s)));
    $("it").innerHTML = `<table><thead><tr><th>Code</th><th>Item</th><th>Category</th><th>Unit</th><th class="n">Price</th>${C ? `<th class="n">Cost</th><th class="n">Margin</th>` : ""}<th class="n">In stock</th><th>Status</th>${M ? "<th></th>" : ""}</tr></thead><tbody>
    ${rows.length ? rows.map((p) => `<tr${p.archived ? ' class="strike"' : ""}><td class="mute">${esc(p.sku)}</td><td><b>${esc(p.name)}</b>${p.sellable ? "" : ` <span class="tag t-mute">Ingredient</span>`}</td><td>${esc(p.category)}</td><td>${esc(p.unit)}</td><td class="n">${p.sellable ? rwf(p.price) : "—"}</td>
      ${C ? `<td class="n">${rwf(p.cost)}</td><td class="n">${p.sellable && p.price ? Math.round(((p.price - p.cost) / p.price) * 100) + "%" : "—"}</td>` : ""}<td class="n"><b>${q(p.on_hand)}</b></td><td>${p.archived ? `<span class="tag t-mute">Removed</span>` : stTag(p)}</td>
      ${M ? `<td style="white-space:nowrap"><button class="btn sm alt" data-e="${p.id}">Edit</button> <button class="btn sm ghost" data-a="${p.id}">${p.archived ? "Restore" : "Remove"}</button></td>` : ""}</tr>`).join("") : `<tr><td colspan="10" class="empty">No items found.</td></tr>`}</tbody></table>`;
  };
  setExp("ix", "items");
  for (const i of ["is", "ic", "ia"]) $(i).addEventListener("input", draw);
  $("iadd")?.addEventListener("click", () => itemModal(null, () => go("items", true)));
  $("it").addEventListener("click", async (e) => {
    const ed = e.target.closest("[data-e]"); if (ed) return itemModal(prodById(ed.dataset.e), () => go("items", true));
    const ar = e.target.closest("[data-a]"); if (ar) { const p = prodById(ar.dataset.a); try { await api(`/api/items/${p.id}/archive`, { method: "POST", body: { archived: !p.archived } }); toast(p.archived ? "Item restored" : "Item removed (history is kept)"); await refreshBoot(); draw(); } catch (x) { toast(x.message); } }
  });
  draw();
};

/* ---------- Inventory ---------- */
const MOVE = { opening: ["Opening stock", "t-mute"], purchase: ["Bought", "t-ind"], produced: ["Made in kitchen", "t-ind"], returned: ["Returned", "t-ind"], used: ["Used in kitchen", "t-amb"], damaged: ["Damaged", "t-cor"], expired: ["Expired", "t-cor"], gift: ["Free gift", "t-amb"], count: ["Count correction", "t-mute"] };
function moveModal(kind, pid, after) {
  const items = S.boot.products.filter((p) => !p.archived);
  if (!items.length) { toast("Add items first."); return; }
  const types = kind === "in" ? ["purchase", "produced", "returned"] : kind === "loss" ? ["used", "damaged", "expired", "gift"] : ["count"];
  const title = kind === "in" ? "Receive stock" : kind === "loss" ? "Record used / damaged / expired" : "Stock count";
  formModal({ title, submit: "Save",
    fields: fld("Item", `<select name="product_id" id="mvp" required>${opts(items.map((p) => [p.id, `${p.name} (${q(p.on_hand)} ${p.unit} now)`]), pid)}</select>`, true) +
      (kind === "count" ? "" : fld("Type", `<select name="type">${opts(types.map((t) => [t, MOVE[t][0]]))}</select>`)) +
      (kind === "count" ? `<input type="hidden" name="type" value="count">` + fld("Counted quantity (what you physically have)", `<input name="qty" inputmode="decimal" required>`, true)
        : fld("Quantity", `<input name="qty" inputmode="decimal" required>`)) +
      (kind === "in" ? fld("Cost each (RWF)", `<input name="unit_cost" id="mvc" inputmode="numeric" placeholder="${can("costs.view") ? "" : "Leave empty if unsure"}">`) + fld("Supplier / made by", `<input name="supplier" maxlength="60">`) + fld("Invoice / batch no.", `<input name="ref" maxlength="40">`) : "") +
      fld("Date", `<input type="date" name="date" value="${today()}" max="${today()}">`) + fld("Note", `<input name="note" maxlength="200">`, true) +
      (kind === "in" && can("items.manage") ? `<label class="w" style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" name="update_cost" value="1" style="width:20px;min-height:20px"> Also update the item's cost price to this cost</label>` : ""),
    onSubmit: async (v) => { v.update_cost = v.update_cost === "1"; await api("/api/moves", { method: "POST", body: v }); closeModal(); toast("Stock updated"); await refreshBoot(); after && after(); },
    onMount: null });
  const sel = $("mvp"), cost = $("mvc"); const fill = () => { const p = prodById(sel.value); if (cost && p && p.cost != null) cost.value = p.cost || ""; }; if (cost) { sel.addEventListener("change", fill); fill(); }
}
function voidModal(title, url, after) {
  formModal({ title, danger: true, submit: "Cancel it", fields: fld("Reason (required, saved in the audit log)", `<input name="reason" required minlength="3" maxlength="200">`, true),
    onSubmit: async (v) => { await api(url, { method: "POST", body: v }); closeModal(); toast("Cancelled"); await refreshBoot(); after(); } });
}
PAGES.inventory = async (el, alive) => {
  await refreshBoot(); if (!alive()) return;
  let tab = "levels", low = false;
  el.innerHTML = `<div class="toolbar"><div class="chips" id="vt"><button data-t="levels" aria-pressed="true">Stock levels</button><button data-t="moves" aria-pressed="false">Movements</button></div>${expBtns("vx")}<span style="flex:1"></span>
    ${can("stock.in") ? `<button class="btn" id="v-in">${icon("in")}Receive stock</button>` : ""}${can("stock.loss") ? `<button class="btn alt" id="v-loss">${icon("minus")}Used / damaged</button>` : ""}${can("stock.count") ? `<button class="btn alt" id="v-count">Stock count</button>` : ""}</div><div id="vb"></div>`;
  const levels = () => {
    setExp("vx", "inventory");
    const P = S.boot.products.filter((p) => !p.archived), C = can("costs.view"), val = P.reduce((a, p) => a + Math.max(p.on_hand, 0) * (p.cost || 0), 0);
    $("vb").innerHTML = `<div class="kpis"><div class="card kpi"><p>Items</p><strong>${P.length}</strong></div><div class="card kpi ${P.filter((p) => p.status === "low").length ? "r" : ""}"><p>Running low</p><strong>${P.filter((p) => p.status === "low").length}</strong></div><div class="card kpi"><p>Need checking</p><strong>${P.filter((p) => p.status === "check").length}</strong></div>${C ? `<div class="card kpi"><p>Stock value (at cost)</p><strong>${rwf(val)}</strong></div>` : ""}</div>
    <div class="toolbar"><label class="fl grow">Search<input id="ls" placeholder="Item name"></label><div class="chips"><button id="llow" aria-pressed="${low}">Low only</button></div></div><div class="card tw" id="lt"></div>`;
    const draw = () => { const s = $("ls").value.toLowerCase(); const rows = P.filter((p) => (!low || p.status === "low" || p.status === "check") && (!s || p.name.toLowerCase().includes(s)));
      $("lt").innerHTML = `<table><thead><tr><th>Item</th><th>Category</th><th class="n">In stock</th><th>Unit</th><th class="n">Reorder at</th><th>Status</th>${C ? `<th class="n">Value</th>` : ""}</tr></thead><tbody>${rows.length ? rows.map((p) => `<tr class="click" data-h="${p.id}"><td><b>${esc(p.name)}</b></td><td>${esc(p.category)}</td><td class="n"><b class="${p.on_hand < 0 ? "bad" : p.status === "low" ? "warn" : ""}">${q(p.on_hand)}</b></td><td>${esc(p.unit)}</td><td class="n">${q(p.reorder)}</td><td>${stTag(p)}</td>${C ? `<td class="n">${rwf(Math.max(p.on_hand, 0) * p.cost)}</td>` : ""}</tr>`).join("") : `<tr><td colspan="7" class="empty">No items.</td></tr>`}</tbody></table>`; };
    $("ls").addEventListener("input", draw); $("llow").addEventListener("click", (e) => { low = !low; e.target.setAttribute("aria-pressed", low); draw(); });
    $("lt").addEventListener("click", async (e) => { const r = e.target.closest("[data-h]"); if (!r) return; const p = prodById(r.dataset.h); const m = (await api(`/api/moves?product_id=${p.id}`)).moves;
      modal({ title: `History — ${esc(p.name)}`, wide: true, body: `<p class="hint">Stock changes other than sales (sales are in Sales & receipts). Now in stock: <b>${q(p.on_hand)} ${esc(p.unit)}</b></p>${movesTable(m)}` }); });
    draw();
  };
  const movesTable = (m) => `<div class="tw"><table><thead><tr><th>Date</th><th>Item</th><th>Type</th><th class="n">Qty</th>${can("costs.view") ? `<th class="n">Cost each</th>` : ""}<th>Details</th><th>By</th><th></th></tr></thead><tbody>${m.length ? m.map((x) => `<tr${x.voided ? ' class="strike"' : ""}><td>${esc(short(x.date))} ${tm(x.t)}</td><td><b>${esc(x.name)}</b></td><td><span class="tag ${MOVE[x.type]?.[1] || "t-mute"}">${esc(MOVE[x.type]?.[0] || x.type)}</span></td><td class="n"><b class="${x.qty > 0 ? "ok" : "bad"}">${x.qty > 0 ? "+" : ""}${q(x.qty)}</b></td>${can("costs.view") ? `<td class="n">${rwf(x.unit_cost || 0)}</td>` : ""}<td class="mute">${esc([x.supplier, x.ref, x.note, x.voided ? "Cancelled: " + x.void_reason : ""].filter(Boolean).join(" · "))}</td><td>${esc(S.boot.names[x.user_id] || "—")}</td><td>${!x.voided && can("stock.void") && x.type !== "opening" ? `<button class="btn sm ghost" data-v="${x.id}">Cancel</button>` : ""}</td></tr>`).join("") : `<tr><td colspan="8" class="empty">No stock changes.</td></tr>`}</tbody></table></div>`;
  const moves = async () => {
    $("vb").innerHTML = rangeBar("mr", "month", staffSel("mu")) + `<div class="card" id="mt"></div>`;
    const load = async (a, b) => { const p = withUser({ from: a, to: b }, "mu"); setExp("vx", "movements", p); const m = (await api(`/api/moves?${new URLSearchParams(p)}`)).moves; if (alive()) $("mt").innerHTML = movesTable(m); };
    const get = bindRange("mr", load); $("mu").addEventListener("change", () => load(...get()));
    $("mt").addEventListener("click", (e) => { const v = e.target.closest("[data-v]"); if (v) voidModal("Cancel stock change", `/api/moves/${v.dataset.v}/void`, () => load(...get())); });
    await load(...get());
  };
  const show = () => (tab === "levels" ? levels() : moves());
  $("vt").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; tab = b.dataset.t; for (const c of $("vt").children) c.setAttribute("aria-pressed", c === b); show(); });
  const after = async () => { await refreshBoot(); show(); };
  $("v-in")?.addEventListener("click", () => moveModal("in", null, after)); $("v-loss")?.addEventListener("click", () => moveModal("loss", null, after)); $("v-count")?.addEventListener("click", () => moveModal("count", null, after));
  show();
};

/* ---------- Expenses ---------- */
function expenseModal(after) {
  const L = S.boot.lists;
  formModal({ title: "Add expense", submit: "Save expense",
    fields: fld("Type of expense", `<select name="category" required>${opts(L.expense_categories)}</select>`) + fld("Amount (RWF)", `<input name="amount" inputmode="numeric" required>`) +
      fld("What was it for?", `<input name="description" maxlength="120" placeholder="e.g. Moto to Kimironko market">`, true) + fld("Paid by", `<select name="method">${opts(L.payment_methods)}</select>`) +
      fld("Date", `<input type="date" name="date" value="${today()}" max="${today()}">`) + fld("Note", `<input name="note" maxlength="200">`, true),
    onSubmit: async (v) => { await api("/api/expenses", { method: "POST", body: v }); closeModal(); toast("Expense saved"); after && after(); } });
}
PAGES.expenses = async (el, alive) => {
  await refreshBoot();
  el.innerHTML = rangeBar("er", "month", `${staffSel("eu")}<span style="flex:1"></span>${expBtns("ex")}${can("expense.add") ? `<button class="btn" id="eadd">${icon("plus")}Add expense</button>` : ""}`) + `<div id="eb"></div>`;
  const load = async (a, b) => {
    const p = withUser({ from: a, to: b }, "eu"); setExp("ex", "expenses", p);
    const E = (await api(`/api/expenses?${new URLSearchParams(p)}`)).expenses; if (!alive()) return;
    const ok = E.filter((x) => !x.voided), tot = ok.reduce((s, x) => s + x.amount, 0), cat = {}; for (const x of ok) cat[x.category] = (cat[x.category] || 0) + x.amount;
    $("eb").innerHTML = `<div class="kpis"><div class="card kpi"><p>Total expenses</p><strong>${rwf(tot)}</strong></div><div class="card kpi"><p>Number of expenses</p><strong>${ok.length}</strong></div><div class="card kpi"><p>Biggest type</p><strong style="font-size:20px">${esc(Object.entries(cat).sort((a, b) => b[1] - a[1])[0]?.[0] || "—")}</strong></div></div>
    <div class="cols"><div class="card tw"><table><thead><tr><th>Date</th><th>Type</th><th>Description</th><th>Paid by</th><th>By</th><th class="n">Amount</th><th></th></tr></thead><tbody>
    ${E.length ? E.map((x) => `<tr${x.voided ? ' class="strike"' : ""}><td>${esc(short(x.date))}</td><td><span class="tag t-cor">${esc(x.category)}</span></td><td>${esc(x.description || "—")}${x.voided ? `<br><small class="bad">Cancelled: ${esc(x.void_reason)}</small>` : ""}</td><td>${esc(x.method)}</td><td>${esc(S.boot.names[x.user_id] || "—")}</td><td class="n"><b>${rwf(x.amount)}</b></td><td>${!x.voided && can("expense.void") ? `<button class="btn sm ghost" data-v="${x.id}">Cancel</button>` : ""}</td></tr>`).join("") : `<tr><td colspan="7" class="empty">No expenses in this period.</td></tr>`}</tbody></table></div>
    <div class="card"><div class="hd"><h2>By type</h2></div>${bars(Object.entries(cat).map(([name, v]) => ({ name, v })).sort((a, b) => b.v - a.v), "var(--cor)")}</div></div>`;
  };
  const get = bindRange("er", load); $("eu").addEventListener("change", () => load(...get()));
  $("eadd")?.addEventListener("click", () => expenseModal(() => load(...get())));
  $("eb").addEventListener("click", (e) => { const v = e.target.closest("[data-v]"); if (v) voidModal("Cancel expense", `/api/expenses/${v.dataset.v}/void`, () => load(...get())); });
  await load(...get());
};

/* ---------- Day book ---------- */
PAGES.daybook = async (el, alive) => {
  await refreshBoot();
  el.innerHTML = `<div class="toolbar"><button class="btn alt" id="dp">‹ Previous day</button><label class="fl">Day<input type="date" id="dd" value="${today()}" max="${today()}"></label><button class="btn alt" id="dn">Next day ›</button><button class="btn alt" id="dt">Today</button><span style="flex:1"></span>${expBtns("dx")}<button class="btn alt" id="dprint">${icon("print")}Print</button></div><div id="db"></div>`;
  let D;
  const load = async () => {
    setExp("dx", "daybook", { date: $("dd").value });
    D = await api(`/api/daybook?date=${$("dd").value}`); if (!alive()) return;
    const S1 = D.sales.filter((s) => !s.voided), sales = S1.reduce((a, s) => a + s.total, 0), exp = D.expenses.filter((x) => !x.voided).reduce((a, x) => a + x.amount, 0);
    const byM = {}; for (const s of S1) byM[s.method] = (byM[s.method] || 0) + s.total;
    $("db").innerHTML = `<h2 style="margin:0 0 12px">${esc(nice(D.date))}</h2><div class="kpis"><div class="card kpi"><p>Sales</p><strong>${rwf(sales)}</strong><small>${S1.length} receipts</small></div><div class="card kpi"><p>Expenses</p><strong>${rwf(exp)}</strong></div><div class="card kpi ${sales - exp >= 0 ? "g" : "r"}"><p>Sales − expenses</p><strong>${rwf(sales - exp)}</strong></div>
      ${Object.entries(byM).map(([m, v]) => `<div class="card kpi"><p>${esc(m)}</p><strong>${rwf(v)}</strong></div>`).join("")}</div>
    <div class="cols"><div class="card"><div class="hd"><h2>Receipts</h2></div><div class="tw"><table><thead><tr><th>Time</th><th>Receipt</th><th>Items</th><th>Paid by</th><th class="n">Total</th></tr></thead><tbody>${D.sales.length ? D.sales.map((s, i) => `<tr class="click${s.voided ? " strike" : ""}" data-s="${i}"><td>${tm(s.t)}</td><td><b>${esc(s.receipt_no)}</b></td><td>${esc(s.items.map((x) => `${q(x.qty)}× ${x.name}`).join(", "))}</td><td>${esc(s.method)}</td><td class="n"><b>${rwf(s.total)}</b></td></tr>`).join("") : `<tr><td colspan="5" class="empty">No sales.</td></tr>`}</tbody></table></div></div>
      <div><div class="card" style="margin-bottom:18px"><div class="hd"><h2>Expenses</h2></div>${D.expenses.length ? `<div class="list">${D.expenses.map((x) => `<div class="row${x.voided ? " strike" : ""}"><div class="m"><b>${esc(x.description || x.category)}</b><small>${esc(x.category)} · ${esc(x.method)} · ${tm(x.t)}</small></div><div class="v bad">−${rwf(x.amount)}</div></div>`).join("")}</div>` : `<div class="empty">No expenses.</div>`}</div>
      <div class="card"><div class="hd"><h2>Stock changes</h2></div>${D.moves.length ? `<div class="list">${D.moves.map((m) => `<div class="row${m.voided ? " strike" : ""}"><span class="tag ${MOVE[m.type]?.[1]}">${esc(MOVE[m.type]?.[0] || m.type)}</span><div class="m"><b>${esc(m.name)}</b><small>${esc([m.supplier, m.note].filter(Boolean).join(" · "))} ${tm(m.t)}</small></div><div class="v ${m.qty > 0 ? "ok" : "bad"}">${m.qty > 0 ? "+" : ""}${q(m.qty)}</div></div>`).join("")}</div>` : `<div class="empty">No stock changes.</div>`}</div></div></div>
    <div class="card tw"><div class="hd"><h2>Stock at closing</h2></div><table><thead><tr><th>Item</th><th class="n">Came in</th><th class="n">Sold</th><th class="n">Other out</th><th class="n">Left at closing</th><th>Status</th></tr></thead><tbody>${D.closing.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td class="n">${q(p.came_in)}</td><td class="n">${q(p.sold)}</td><td class="n">${q(p.other_out)}</td><td class="n"><b>${q(p.on_hand)}</b> ${esc(p.unit)}</td><td>${stTag(p)}</td></tr>`).join("")}</tbody></table></div>`;
  };
  $("db").addEventListener("click", (e) => { const r = e.target.closest("[data-s]"); if (r) showReceipt(D.sales[+r.dataset.s], load); });
  $("dp").addEventListener("click", () => { $("dd").value = shift($("dd").value, -1); load(); });
  $("dn").addEventListener("click", () => { if ($("dd").value < today()) { $("dd").value = shift($("dd").value, 1); load(); } });
  $("dt").addEventListener("click", () => { $("dd").value = today(); load(); });
  $("dd").addEventListener("change", load);
  $("dprint").addEventListener("click", () => printHTML(`<div class="wideprint"><h2>${esc(S.shop.name)} — Day book</h2>${$("db").innerHTML}</div>`));
  await load();
};

/* ---------- Reports ---------- */
PAGES.reports = async (el, alive) => {
  await refreshBoot();
  el.innerHTML = rangeBar("rr", "month", `<span style="flex:1"></span>${expBtns("rxx")}${can("export") ? `<a class="btn" id="rx" href="#" title="Every receipt, sale line, stock movement and expense in one workbook">${icon("down")}All data (Excel)</a>` : ""}`) + `<div id="rb"></div>`;
  const load = async (a, b) => {
    const R = await api(`/api/reports?from=${a}&to=${b}`); if (!alive()) return;
    if ($("rx")) $("rx").href = `/api/export.xlsx?from=${a}&to=${b}`;
    setExp("rxx", "reports", { from: a, to: b });
    const line = (t, v, c = "") => `<div class="${c}"><span>${t}</span><b>${v}</b></div>`;
    $("rb").innerHTML = `<div class="kpis"><div class="card kpi"><p>Sales</p><strong>${rwf(R.sales)}</strong><small>${R.receipts} receipts · avg ${rwf(R.avg_receipt)}</small></div><div class="card kpi"><p>Gross profit</p><strong>${rwf(R.gross)}</strong><small>${R.sales ? Math.round((R.gross / R.sales) * 100) : 0}% margin</small></div><div class="card kpi"><p>Expenses</p><strong>${rwf(R.expenses)}</strong></div><div class="card kpi ${R.net >= 0 ? "g" : "r"}"><p>Net profit</p><strong>${rwf(R.net)}</strong></div></div>
    <div class="cols"><div class="card fill"><div class="hd"><h2>Sales and expenses per day</h2></div><div class="chart" id="rc"></div><div class="legend"><span><i style="background:var(--pri)"></i>Sales</span><span><i style="background:var(--cor)"></i>Expenses</span></div></div>
      <div class="card pl"><div class="hd" style="display:flex"><h2>Profit & loss</h2></div>${line("Sales (money received)", rwf(R.sales))}${line("Discounts given (already taken off)", rwf(R.discounts))}${line("Cost of items sold", "− " + rwf(R.cogs))}${line("Gross profit", rwf(R.gross))}${line("Expenses", "− " + rwf(R.expenses))}${line("Losses (damaged, expired, gifts)", "− " + rwf(R.losses))}<div class="tot"><span>Net profit</span><span class="${R.net >= 0 ? "ok" : "bad"}">${rwf(R.net)}</span></div>${line("Stock bought (cash out, for info)", rwf(R.purchases))}${line("Cancelled sales", String(R.voided))}</div></div>
    <div class="cols even"><div class="card"><div class="hd"><h2>Sales by category</h2></div>${bars(R.by_category)}</div><div class="card"><div class="hd"><h2>Expenses by type</h2></div>${bars(R.exp_by_category, "var(--cor)")}</div></div>
    <div class="cols even"><div class="card"><div class="hd"><h2>Money by payment method</h2></div>${bars(R.by_method, "var(--ind)")}</div><div class="card"><div class="hd"><h2>Sales by staff</h2></div>${bars(R.by_staff, "var(--amb)")}</div></div>
    <div class="card tw"><div class="hd"><h2>Sales by item</h2></div><table><thead><tr><th>Item</th><th class="n">Qty sold</th><th class="n">Sales</th><th class="n">Cost</th><th class="n">Profit</th><th class="n">Margin</th></tr></thead><tbody>${R.by_item.length ? R.by_item.map((i) => `<tr><td><b>${esc(i.name)}</b></td><td class="n">${q(i.qty)}</td><td class="n">${rwf(i.v)}</td><td class="n">${rwf(i.cost)}</td><td class="n"><b>${rwf(i.v - i.cost)}</b></td><td class="n">${i.v ? Math.round(((i.v - i.cost) / i.v) * 100) + "%" : "—"}</td></tr>`).join("") : `<tr><td colspan="6" class="empty">No sales in this period.</td></tr>`}</tbody></table></div>`;
    $("rb").insertAdjacentHTML("beforeend", `<div class="card" style="margin-top:18px"><div class="hd"><h2>Download one person's activity</h2></div><div class="bd"><p style="margin-top:0" class="hint">Only what that person did — their sales, expenses, stock changes and actions — instead of the whole report.</p><div class="toolbar" style="margin:0">${staffSel("rau")}<button class="btn" id="raub">${icon("down")}Choose period and download</button></div></div></div>`);
    $("rau").options[0].textContent = "Choose a person…";
    $("raub").addEventListener("click", () => { const s = $("rau"); if (!s.value) { toast("Choose a person first."); return; } activityModal(s.value, s.options[s.selectedIndex].textContent); });
    const days = [], sd = Object.fromEntries(R.by_day.map((x) => [x.date, x.v])), ed = Object.fromEntries(R.exp_by_day.map((x) => [x.date, x.v]));
    for (let d = a, i = 0; d <= b && i < 120; d = shift(d, 1), i++) days.push({ label: short(d), v: sd[d] || 0, v2: ed[d] || 0 });
    barChart($("rc"), days, { series2: true });
  };
  const get = bindRange("rr", load); await load(...get());
};

/* ---------- Customers ---------- */
PAGES.customers = async (el, alive) => {
  const load = async () => {
    const C = (await api("/api/customers")).customers; if (!alive()) return;
    el.innerHTML = `<div class="toolbar"><label class="fl grow">Search<input id="cs" placeholder="Name or phone"></label>${expBtns("cx")}<button class="btn" id="cadd">${icon("plus")}Add customer</button></div><div class="card tw" id="ct"></div><p class="hint">Customers you add here appear in the "Customer" box on New sale. Their visits and spending are counted automatically.</p>`;
    const draw = () => { const s = $("cs").value.toLowerCase(); const rows = C.filter((c) => !s || c.name.toLowerCase().includes(s) || (c.phone || "").includes(s));
      $("ct").innerHTML = `<table><thead><tr><th>Name</th><th>Phone</th><th class="n">Visits</th><th class="n">Total spent</th><th>Last visit</th><th>Note</th><th></th></tr></thead><tbody>${rows.length ? rows.map((c) => `<tr><td><b>${esc(c.name)}</b></td><td>${esc(c.phone || "—")}</td><td class="n">${c.visits}</td><td class="n"><b>${rwf(c.spent)}</b></td><td>${c.last_visit ? esc(short(c.last_visit)) : "—"}</td><td class="mute">${esc(c.note || "")}</td><td><button class="btn sm alt" data-e="${c.id}">Edit</button></td></tr>`).join("") : `<tr><td colspan="7" class="empty">No customers yet.</td></tr>`}</tbody></table>`; };
    const edit = (c) => formModal({ title: c ? "Edit customer" : "Add customer", fields: fld("Name", `<input name="name" required maxlength="60" value="${esc(c?.name || "")}">`, true) + fld("Phone", `<input name="phone" maxlength="30" inputmode="tel" value="${esc(c?.phone || "")}">`) + fld("Note", `<input name="note" maxlength="200" value="${esc(c?.note || "")}">`),
      onSubmit: async (v) => { await api("/api/customers", { method: "POST", body: { ...v, id: c?.id } }); closeModal(); toast("Customer saved"); load(); } });
    setExp("cx", "customers");
    $("cs").addEventListener("input", draw); $("cadd").addEventListener("click", () => edit(null));
    $("ct").addEventListener("click", (e) => { const b = e.target.closest("[data-e]"); if (b) edit(C.find((c) => c.id === +b.dataset.e)); });
    draw();
  };
  await load();
};

/* ---------- Users & roles ---------- */
PAGES.users = async (el, alive) => {
  const U = (await api("/api/users")).users; if (!alive()) return;
  pendingUsers = U.filter((u) => u.status === "pending").length; buildNav();
  const pend = U.filter((u) => u.status === "pending"), rest = U.filter((u) => u.status !== "pending");
  el.innerHTML = `<div id="uw"><div class="toolbar"><p class="hint grow" style="margin:0;align-self:center">Add staff accounts yourself, or approve people who signed up on the log-in page.</p>${expBtns("ux")}<button class="btn" id="uadd">${icon("adduser")}Add user</button></div>${pend.length ? `<div class="card" style="margin-bottom:18px"><div class="hd"><h2>Waiting for approval (${pend.length})</h2></div><div class="list">${pend.map((u) => `<div class="row" style="flex-wrap:wrap"><div class="av">${esc(ini(u.name))}</div><div class="m"><b>${esc(u.name)}</b><small>@${esc(u.username)}${u.phone ? " · " + esc(u.phone) : ""} · signed up ${esc(when(u.created_t))}</small></div>
      <select data-role-for="${u.id}" style="width:auto">${opts([["cashier", "Cashier"], ["manager", "Manager"], ["admin", "Administrator"]], "cashier")}</select><button class="btn sm" data-approve="${u.id}">Approve</button><button class="btn sm alt" data-reject="${u.id}">Reject</button></div>`).join("")}</div></div>` : ""}
    <div class="card tw"><div class="hd"><h2>Team</h2></div><table><thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Last login</th><th>Signed in</th><th></th></tr></thead><tbody>
    ${rest.map((u) => { const me = u.id === S.user.id; return `<tr><td><div style="display:flex;gap:10px;align-items:center"><div class="av" style="${u.status === "active" ? "" : "opacity:.4"}">${esc(ini(u.name))}</div><div><b>${esc(u.name)}${me ? " (you)" : ""}</b><br><small class="mute">@${esc(u.username)}${u.phone ? " · " + esc(u.phone) : ""}</small></div></div></td>
      <td>${me ? esc(ROLE[u.role]) : `<select data-role="${u.id}" style="width:auto">${opts([["cashier", "Cashier"], ["manager", "Manager"], ["admin", "Administrator"]], u.role)}</select>`}</td>
      <td>${u.status === "active" ? `<span class="tag t-pri">Active</span>` : `<span class="tag t-cor">Switched off</span>`}${u.must_change ? ` <span class="tag t-amb">Must change password</span>` : ""}</td>
      <td>${esc(when(u.last_login_t))}</td><td>${u.sessions ? `${u.sessions} device${u.sessions > 1 ? "s" : ""}` : "—"}</td>
      <td style="white-space:nowrap"><button class="btn sm alt" data-act="${u.id}">${icon("down")}Activity</button> ${me ? "" : `<button class="btn sm alt" data-st="${u.id}|${u.status === "active" ? "disabled" : "active"}">${u.status === "active" ? "Switch off" : "Switch on"}</button> <button class="btn sm alt" data-pw="${u.id}">New password</button> ${u.sessions ? `<button class="btn sm ghost" data-lo="${u.id}">Log out</button>` : ""}`}</td></tr>`; }).join("")}</tbody></table></div>
    <div class="card" style="margin-top:18px"><div class="hd"><h2>What each role can do</h2></div><div class="tw"><table><thead><tr><th>Permission</th><th>Cashier</th><th>Manager</th><th>Administrator</th></tr></thead><tbody>
    ${[["Make sales, print receipts", 1, 1, 1], ["Receive stock, record used / damaged", 1, 1, 1], ["Add expenses, view day book", 1, 1, 1], ["Customers", 1, 1, 1], ["Download Excel / PDF of the pages they can see", 1, 1, 1], ["Sell custom items (not in the item list)", 1, 1, 1], ["See cost prices & profit, money report", 0, 1, 1], ["Add / edit items and prices", 0, 1, 1], ["Cancel sales, expenses, stock changes; stock count", 0, 1, 1], ["Change prices at the till", 0, 1, 1], ["Add users, approve accounts, roles, audit log, settings, backup", 0, 0, 1]].map(([t, ...r]) => `<tr><td>${t}</td>${r.map((x) => `<td>${x ? '<span class="ok">✓</span>' : '<span class="mute">—</span>'}</td>`).join("")}</tr>`).join("")}</tbody></table></div></div></div>`;
  const uw = $("uw"); setExp("ux", "users");
  $("uadd").addEventListener("click", () => formModal({ title: "Add a user account", submit: "Create account",
    fields: fld("Full name", `<input name="name" required maxlength="60" autocomplete="off">`, true) +
      fld("Username (no spaces)", `<input name="username" required pattern="[a-zA-Z0-9._\\-]{3,30}" title="No spaces, e.g. eric" placeholder="e.g. eric" autocapitalize="none" spellcheck="false" autocomplete="off">`) +
      fld("Phone", `<input name="phone" inputmode="tel" maxlength="30" autocomplete="off">`) +
      fld("Role", `<select name="role">${opts([["cashier", "Cashier — sells, stock in, expenses"], ["manager", "Manager — also items, prices, reports"], ["admin", "Administrator — everything"]], "cashier")}</select>`, true) +
      fld("Temporary password (at least 8 characters)", `<input name="password" required minlength="8" autocomplete="new-password">`, true) +
      `<label class="w" style="display:flex;gap:8px;align-items:center;font-weight:600"><input type="checkbox" name="must_change" value="1" checked style="width:20px;min-height:20px"> Ask them to choose their own password the first time they log in (recommended)</label>`,
    note: `<p class="hint">The account is active straight away. Give the username and temporary password to the person privately.</p>`,
    onSubmit: async (v) => { v.must_change = v.must_change === "1"; await api("/api/users", { method: "POST", body: v }); closeModal(); toast(`Account created for ${v.name}`); go("users", true); } }));
  const act = async (fn, msg) => { try { await fn(); toast(msg); go("users", true); } catch (e) { toast(e.message); } };
  uw.addEventListener("click", (e) => {
    const t = e.target;
    if (t.dataset.approve) { const role = uw.querySelector(`[data-role-for="${t.dataset.approve}"]`).value; act(async () => { await api(`/api/users/${t.dataset.approve}`, { method: "POST", body: { status: "active", role } }); }, "Approved"); }
    if (t.dataset.reject) act(() => api(`/api/users/${t.dataset.reject}`, { method: "POST", body: { status: "disabled" } }), "Rejected");
    if (t.dataset.st) { const [id, st] = t.dataset.st.split("|"); act(() => api(`/api/users/${id}`, { method: "POST", body: { status: st } }), st === "active" ? "Switched on" : "Switched off"); }
    const ab = t.closest("[data-act]"); if (ab) { const u = U.find((x) => x.id === +ab.dataset.act); activityModal(u.id, u.name); return; }
    if (t.dataset.lo) act(() => api(`/api/users/${t.dataset.lo}/logout`, { method: "POST" }), "Logged out on all devices");
    if (t.dataset.pw) { const u = U.find((x) => x.id === +t.dataset.pw); formModal({ title: `New password for ${esc(u.name)}`, submit: "Set password",
      fields: fld("Temporary password", `<input name="password" required minlength="8" autocomplete="off">`, true), note: `<p class="hint">At least 8 characters. Give it to ${esc(u.name)} in person — they must choose their own password when they next log in.</p>`,
      onSubmit: async (v) => { await api(`/api/users/${u.id}/reset-password`, { method: "POST", body: v }); closeModal(); toast("Temporary password set"); go("users", true); } }); }
  });
  uw.addEventListener("change", (e) => { const s = e.target.closest("[data-role]"); if (s) act(() => api(`/api/users/${s.dataset.role}`, { method: "POST", body: { role: s.value } }), "Role changed"); });
};

/* ---------- Audit log ---------- */
PAGES.audit = async (el, alive) => {
  el.innerHTML = rangeBar("ar", "month", `<span style="flex:1"></span>${expBtns("ax")}`) + `<div class="toolbar"><label class="fl">Show<select id="af">${opts([["", "Everything"], ["login", "Log-ins (incl. failed)"], ["sale", "Sales"], ["stock", "Stock"], ["item", "Items & prices"], ["expense", "Expenses"], ["user", "Users"], ["account", "New accounts"], ["password", "Passwords"], ["settings", "Settings"], ["export", "Exports"], ["backup", "Backups"]])}</select></label><span class="hint grow" style="align-self:center">Every action is recorded with the person, time and device address. Entries cannot be edited or deleted.</span></div><div class="card tw" id="at"></div><div style="text-align:center;margin-top:12px"><button class="btn alt" id="am">Load older</button></div>`;
  let rows = [];
  let span = range("month");
  const load = async (more) => { setExp("ax", "audit", { from: span[0], to: span[1] }); const before = more && rows.length ? rows[rows.length - 1].t : ""; const r = (await api(`/api/audit?action=${encodeURIComponent($("af").value)}&before=${before}&from=${span[0]}&to=${span[1]}`)).rows; if (!alive()) return; rows = more ? rows.concat(r) : r; $("am").hidden = r.length < 200;
    $("at").innerHTML = `<table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th><th>Device IP</th></tr></thead><tbody>${rows.length ? rows.map((a) => `<tr><td style="white-space:nowrap">${esc(when(a.t))}</td><td>${esc(a.name || "—")}</td><td><span class="tag ${a.action.includes("failed") || a.action.includes("void") ? "t-cor" : a.action.startsWith("login") ? "t-ind" : "t-mute"}">${esc(a.action)}</span></td><td>${esc(a.detail)}</td><td class="mute">${esc(a.ip)}</td></tr>`).join("") : `<tr><td colspan="5" class="empty">Nothing recorded.</td></tr>`}</tbody></table>`; };
  bindRange("ar", (x, y) => { span = [x, y]; load(false); });
  $("af").addEventListener("change", () => load(false)); $("am").addEventListener("click", () => load(true));
  await load(false);
};

/* ---------- Settings & backup ---------- */
PAGES.settings = async (el, alive) => {
  const s = await api("/api/settings"); if (!alive()) return;
  el.innerHTML = `<div class="cols"><div class="card"><div class="hd"><h2>Shop details & receipts</h2></div><form class="bd grid2" id="sf">
    ${fld("Shop name", `<input name="shop_name" maxlength="80" required value="${esc(s.shop_name)}">`)}${fld("Tagline", `<input name="shop_tagline" maxlength="80" value="${esc(s.shop_tagline)}">`)}
    ${fld("Address", `<input name="shop_address" maxlength="120" value="${esc(s.shop_address)}">`)}${fld("Phone", `<input name="shop_phone" maxlength="80" value="${esc(s.shop_phone)}">`)}
    ${fld("Receipt footer", `<input name="receipt_footer" maxlength="160" value="${esc(s.receipt_footer)}">`, true)}
    ${fld("Item categories (comma separated)", `<textarea name="categories">${esc(s.categories)}</textarea>`, true)}
    ${fld("Expense types (comma separated)", `<textarea name="expense_categories">${esc(s.expense_categories)}</textarea>`, true)}
    ${fld("Payment methods (comma separated)", `<textarea name="payment_methods">${esc(s.payment_methods)}</textarea>`, true)}
    ${fld("Auto log-out after no activity (minutes)", `<input name="idle_minutes" inputmode="numeric" value="${esc(s.idle_minutes)}">`)}
    ${fld("Automatic daily backups to keep", `<input name="auto_backup_keep" inputmode="numeric" value="${esc(s.auto_backup_keep)}">`)}
    <label class="fl w" style="flex-direction:row;display:flex;gap:8px;align-items:center"><input type="checkbox" name="allow_negative_stock" value="1" ${s.allow_negative_stock === "1" ? "checked" : ""} style="width:20px;min-height:20px">Allow selling more than the stock shows</label>
    <label class="fl w" style="flex-direction:row;display:flex;gap:8px;align-items:center"><input type="checkbox" name="allow_custom_items" value="1" ${s.allow_custom_items === "1" ? "checked" : ""} style="width:20px;min-height:20px">Allow custom items on New sale (items not in the item list)</label>
    <div class="w"><button class="btn" type="submit">Save settings</button> <span class="err" id="serr"></span></div></form></div>
    <div><div class="card" style="margin-bottom:18px"><div class="hd"><h2>Backup</h2></div><div class="bd"><p style="margin-top:0">Download a full copy of the database (all sales, stock, expenses, users). Keep it on a USB stick or Google Drive. Do this at least once a week.</p><a class="btn" href="/api/backup">${icon("down")}Download backup</a>
      <p class="hint" id="binfo"></p><p class="hint">To restore: stop the app, replace <code>data/grathia.db</code> with the backup file (rename it to grathia.db), start the app.</p></div></div>
    <div class="card"><div class="hd"><h2>Security in this system</h2></div><div class="bd"><ul style="margin:0;padding-left:18px;display:grid;gap:6px">
      <li>Passwords are stored only as salted scrypt hashes — nobody can read them, not even an administrator.</li><li>5 wrong passwords lock that username and device for 15 minutes.</li>
      <li>Sessions end after ${esc(s.idle_minutes)} minutes of no activity, and after 7 days at most.</li><li>New accounts need approval; roles limit what each person can see and do — checked on the server.</li>
      <li>Every action is saved in the audit log. Sales and expenses are never deleted, only cancelled with a reason.</li><li>Protection against cross-site request forgery, click-jacking and script injection.</li></ul></div></div></div></div>`;
  api("/api/backup/info").then((b) => { if ($("binfo")) $("binfo").innerHTML = b.online ? `<b>Automatic backups:</b> the online database (Turso) keeps its own automatic backups. You can still download a copy here.` : `<b>Automatic backups:</b> ${b.count} saved${b.latest ? ` (latest: ${esc(b.latest)})` : ""} in <code>${esc(b.folder)}</code>. A new one is made every day while the app is running.`; }).catch(() => {});
  $("sf").addEventListener("submit", async (e) => { e.preventDefault(); const v = Object.fromEntries(new FormData(e.target)); v.allow_negative_stock = v.allow_negative_stock === "1" ? "1" : "0"; v.allow_custom_items = v.allow_custom_items === "1" ? "1" : "0";
    try { await api("/api/settings", { method: "PUT", body: v }); toast("Settings saved"); await loadMe(); buildNav(); } catch (x) { $("serr").textContent = x.message; } });
};

/* ---------- My account ---------- */
PAGES.account = async (el) => {
  el.innerHTML = `<div class="cols even"><div class="card"><div class="hd"><h2>My details</h2></div><div class="bd"><div style="display:flex;gap:14px;align-items:center"><div class="av" style="width:56px;height:56px;font-size:20px">${esc(ini(S.user.name))}</div><div><b style="font-size:18px">${esc(S.user.name)}</b><br><span class="mute">@${esc(S.user.username)} · ${esc(ROLE[S.user.role])}</span></div></div>
    <h3 style="font-size:14px;margin:18px 0 8px">What I can do</h3><div class="chips">${S.perms.map((p) => `<span class="tag t-mute">${esc(p)}</span>`).join("")}</div></div></div>
    <div class="card"><div class="hd"><h2>Change my password</h2></div><form class="bd" id="pf" style="display:grid;gap:12px">${pwFields()}<button class="btn" type="submit">Change password</button><p class="err" id="perr2"></p></form></div></div>
    <div class="card" style="margin-top:18px"><div class="hd"><h2>Download my activity</h2></div><div class="bd"><p style="margin-top:0">Only your own work: the sales you made, expenses and stock changes you recorded, and your log-ins — for the period you choose.</p>${rangeBar("myr", "month", `<span style="flex:1"></span>${expBtns("myx")}`)}</div></div>`;
  { const set = (f, t) => setExp("myx", "activity", { from: f, to: t }); const get = bindRange("myr", set); set(...get()); }
  bindPw($("pf"), async (v) => { await api("/api/auth/password", { method: "POST", body: v }); toast("Password changed. Other devices were logged out."); $("pf").reset(); }, $("perr2"));
};
function pwFields() { return `<label class="fl">Current password<input type="password" name="current" required autocomplete="current-password"></label><label class="fl">New password<input type="password" name="next" required minlength="8" autocomplete="new-password"></label><div class="pwm"><i></i></div><label class="fl">Repeat new password<input type="password" name="next2" required minlength="8" autocomplete="new-password"></label><span class="hint">Password: at least 8 characters.</span>`; }
function strength(pw) { let s = 0; if (pw.length >= 8) s++; if (pw.length >= 12) s++; if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++; if (/\d/.test(pw)) s++; if (/[^a-zA-Z0-9]/.test(pw)) s++; return s; }
function bindPw(form, submit, err) {
  const meter = form.querySelector(".pwm i"), nw = form.querySelector("[name=next],[name=password]");
  nw.addEventListener("input", () => { const s = strength(nw.value); meter.style.width = (s / 5) * 100 + "%"; meter.style.background = s < 2 ? "var(--bad)" : s < 4 ? "var(--amb)" : "var(--ok)"; });
  form.addEventListener("submit", async (e) => { e.preventDefault(); err.textContent = ""; const v = Object.fromEntries(new FormData(form));
    if ((v.next2 ?? v.password2) !== (v.next ?? v.password)) { err.textContent = "The two new passwords are not the same."; return; }
    const b = form.querySelector("button[type=submit]"); b.disabled = true; try { await submit(v); } catch (x) { err.textContent = x.message; } b.disabled = false; });
}

/* =================== login, sign-up, forced password change =================== */
function showAuth(mode, msg = "") {
  $("shell").hidden = true; $("auth").hidden = false; closeModal();
  const art = `<div class="art"><div class="brand" style="padding:0"><img src="brand/logo-192.png" alt="Grathia Sweet Haven logo" class="logo"><div>${esc(S.shop.name || "Grathia Sweet Haven")}<small style="color:#cfe6e4">${esc(S.shop.tagline || "")}</small></div></div>
    <div><h2>Sales, stock and money — in one secure place.</h2><p>Record every sale and expense, know what's on your shelves, and see your real profit every day.</p>
    <ul><li>Point of sale with printed receipts</li><li>Live stock levels and low-stock alerts</li><li>Daily day book and profit reports</li><li>Staff accounts with approval and roles</li><li>Full audit trail of every action</li></ul></div><small style="color:#9cc5c1">${esc(S.shop.address || "")}</small></div>`;
  let form = "";
  if (mode === "login") form = `<form id="af"><h1>Welcome back</h1><p class="mute" style="margin:0">Log in to your account.</p><div class="tabs2"><button type="button" data-m="login" aria-pressed="true">Log in</button><button type="button" data-m="register" aria-pressed="false">Create account</button></div>
    <div class="fields"><label class="fl">Username<input name="username" required autocomplete="username" autocapitalize="none" spellcheck="false"></label><label class="fl">Password<input name="password" type="password" required autocomplete="current-password"></label>
    <button class="btn lg" type="submit">Log in</button></div><p class="${msg && msg.startsWith("✓") ? "okmsg" : "err"}" id="aerr">${esc(msg.replace(/^✓ /, ""))}</p></form>`;
  if (mode === "register") form = `<form id="af"><h1>Create your account</h1><p class="mute" style="margin:0">An administrator will approve it before you can log in.</p><div class="tabs2"><button type="button" data-m="login" aria-pressed="false">Log in</button><button type="button" data-m="register" aria-pressed="true">Create account</button></div>
    <div class="fields"><label class="fl">Full name<input name="name" required maxlength="60" autocomplete="name"></label><div class="grid2"><label class="fl">Username (no spaces)<input name="username" required pattern="[a-zA-Z0-9._\\-]{3,30}" title="Username: no spaces, e.g. grace" placeholder="e.g. grace" autocomplete="username" autocapitalize="none" spellcheck="false"></label><label class="fl">Phone<input name="phone" inputmode="tel" maxlength="30" autocomplete="tel"></label></div>
    <label class="fl">Password (at least 8 characters)<input name="password" type="password" required minlength="8" autocomplete="new-password"></label><div class="pwm"><i></i></div><label class="fl">Repeat password<input name="password2" type="password" required minlength="8" autocomplete="new-password"></label><span class="hint">Password: at least 8 characters.</span>
    <button class="btn lg" type="submit">Create account</button></div><p class="err" id="aerr"></p></form>`;
  if (mode === "must_change") form = `<form id="af"><h1>Choose a new password</h1><p class="mute" style="margin:0 0 16px">An administrator set a temporary password for you. Please choose your own now.</p><div class="fields">${pwFields()}<button class="btn lg" type="submit">Save and continue</button></div><p class="err" id="aerr"></p><p style="text-align:center"><a href="#" id="alo">Log out</a></p></form>`;
  $("auth").innerHTML = `<div class="auth">${art}<div class="frm">${form}</div></div>`;
  const f = $("af"); f.querySelector("input").focus();
  f.querySelectorAll("[data-m]").forEach((b) => b.addEventListener("click", () => showAuth(b.dataset.m)));
  $("alo")?.addEventListener("click", (e) => { e.preventDefault(); logout(); });
  if (mode === "must_change") { bindPw(f, async (v) => { await api("/api/auth/password", { method: "POST", body: v }); await start(); }, $("aerr")); return; }
  if (mode === "register") { const pw = f.querySelector("[name=password]"), m = f.querySelector(".pwm i"); pw.addEventListener("input", () => { const s = strength(pw.value); m.style.width = (s / 5) * 100 + "%"; m.style.background = s < 2 ? "var(--bad)" : s < 4 ? "var(--amb)" : "var(--ok)"; }); }
  f.addEventListener("submit", async (e) => {
    e.preventDefault(); const v = Object.fromEntries(new FormData(f)), err = $("aerr"); err.className = "err"; err.textContent = "";
    if (mode === "register" && v.password !== v.password2) { err.textContent = "The two passwords are not the same."; return; }
    const b = f.querySelector("button[type=submit]"); b.disabled = true;
    try {
      if (mode === "login") { await api("/api/auth/login", { method: "POST", body: v }); await start(); }
      else { const r = await api("/api/auth/register", { method: "POST", body: v }); showAuth("login", "✓ " + r.message); $("af").querySelector("[name=username]").value = v.username; $("af").querySelector("[name=password]").focus(); }
    } catch (x) { err.textContent = x.message; b.disabled = false; }
  });
}
function sessionEnded(msg) { S.user = null; S.perms = []; S.cart = []; showAuth("login", msg); }
async function logout() { try { await api("/api/auth/logout", { method: "POST" }); } catch (e) {} sessionEnded("✓ You have logged out."); }

/* =================== idle auto-logout =================== */
let lastAct = Date.now();
for (const ev of ["mousemove", "keydown", "click", "touchstart", "scroll"]) addEventListener(ev, () => { lastAct = Date.now(); }, { passive: true });
setInterval(() => { if (S.user && Date.now() - lastAct > (S.shop.idle_minutes || 30) * 60e3) { api("/api/auth/logout", { method: "POST" }).catch(() => {}); sessionEnded(`You were logged out after ${S.shop.idle_minutes || 30} minutes without activity.`); } }, 20e3);
setInterval(() => { $("clock").textContent = new Date().toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); }, 10e3);

/* =================== start =================== */
async function loadMe() { const r = await api("/api/auth/me"); S.user = r.user; S.perms = r.perms; S.shop = r.shop; return r; }
async function start() {
  try { await loadMe(); } catch (e) { $("auth").hidden = false; $("auth").innerHTML = `<div class="empty" style="padding:60px">${esc(e.message)}</div>`; return; }
  if (!S.user) return showAuth("login");
  if (S.user.must_change) return showAuth("must_change");
  try { await refreshBoot(); } catch (e) { return; }
  if (can("users")) { try { pendingUsers = (await api("/api/users")).users.filter((u) => u.status === "pending").length; } catch (e) {} }
  $("auth").hidden = true; $("auth").innerHTML = ""; $("shell").hidden = false; lastAct = Date.now();
  $("clock").textContent = new Date().toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  buildNav(); go(location.hash.replace(/^#\/?/, "") || "dashboard");
}
start();
})();
