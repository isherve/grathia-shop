// Emergency tool for the shop owner. Runs only on the computer that holds the database.
//
//   npm run admin -- list                         show all accounts
//   npm run admin -- reset-password <username>    set a temporary password (must be changed at next login)
//   npm run admin -- make-admin <username>        make an account an active administrator
//   npm run admin -- unlock <username>            switch a disabled/pending account on
//   npm run admin -- reset-data                   delete ALL shop data, keep user accounts (asks first, backs up first)
//   npm run admin -- reset-data keep-items        same, but keep the item list (prices) with stock set to zero
//
// To work on the ONLINE database, first set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in this terminal.
"use strict";
const crypto = require("crypto");
const readline = require("readline");
const path = require("path");
const fs = require("fs");
const { db, ready, backupToFile, isRemote, DATA_DIR, close } = require("./db");

const [cmd, username] = process.argv.slice(2);
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
const findUser = async () => {
  if (!username) { console.log("  Please give a username, for example:  npm run admin -- " + cmd + " grace"); process.exit(1); }
  const u = await db.get("SELECT * FROM users WHERE username = ?", username.toLowerCase());
  if (!u) { console.log(`  No account called "${username}". Run:  npm run admin -- list`); process.exit(1); }
  return u;
};
const log = (action, detail) => db.run("INSERT INTO audit (t, user_id, action, detail, ip) VALUES (?,?,?,?,?)", Date.now(), null, action, detail, "terminal");
const ask = (q, hidden) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  if (hidden) rl._writeToOutput = (s) => rl.output.write(s.includes(q) ? s : "*");
  rl.question(q, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(a); });
});

(async () => {
  await ready;
  console.log(`  Database: ${isRemote ? "ONLINE (Turso)" : "this computer (data/grathia.db)"}`);
  if (cmd === "list") {
    const rows = await db.all("SELECT name, username, role, status, must_change FROM users ORDER BY role, name");
    if (!rows.length) console.log("  No accounts yet. Open the app and click Create account.");
    for (const u of rows) console.log(`  ${u.username.padEnd(18)} ${u.role.padEnd(9)} ${u.status.padEnd(9)} ${u.name}${u.must_change ? "  (must change password)" : ""}`);
  } else if (cmd === "reset-password") {
    const u = await findUser();
    const pw = await ask(`  New temporary password for ${u.name} (at least 8 characters): `, true);
    if (pw.length < 8) { console.log("  Too short. Nothing was changed."); process.exit(1); }
    if (pw.toLowerCase() === u.username.toLowerCase()) { console.log("  The password cannot be the same as the username. Nothing was changed."); process.exit(1); }
    const salt = crypto.randomBytes(16).toString("hex");
    await db.run("UPDATE users SET pass_hash = ?, salt = ?, must_change = 1, status = 'active' WHERE id = ?", hashPw(pw, salt), salt, u.id);
    await db.run("DELETE FROM sessions WHERE user_id = ?", u.id);
    await log("user.password_reset_terminal", u.username);
    console.log(`  Done. ${u.name} can log in with the temporary password and will be asked to choose a new one.`);
    await db.run("DELETE FROM login_fails WHERE key = ?", "u:" + u.username); // clears a lock-out after wrong attempts
  } else if (cmd === "make-admin") {
    const u = await findUser();
    await db.run("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?", u.id);
    await db.run("DELETE FROM sessions WHERE user_id = ?", u.id);
    await log("user.made_admin_terminal", u.username);
    console.log(`  Done. ${u.name} is now an active administrator.`);
  } else if (cmd === "unlock") {
    const u = await findUser();
    await db.run("UPDATE users SET status = 'active' WHERE id = ?", u.id);
    await log("user.unlocked_terminal", u.username);
    console.log(`  Done. ${u.name}'s account is switched on.`);
  } else if (cmd === "reset-data") {
    const keepItems = username === "keep-items";
    const counts = {}; for (const t of ["sales", "sale_items", "payments", "orders", "day_closings", "stock_moves", "expenses", "customers", "products", "audit", "users"]) counts[t] = (await db.get(`SELECT COUNT(*) n FROM ${t}`)).n;
    const count = (t) => counts[t];
    const tables = ["sales", "sale_items", "payments", "orders", "day_closings", "stock_moves", "expenses", "customers", ...(keepItems ? [] : ["products"]), "audit"];
    console.log("\n  This will DELETE:");
    for (const t of tables) console.log(`    ${t.padEnd(12)} ${count(t)} records`);
    console.log(`\n  It will KEEP: ${count("users")} user accounts, shop settings${keepItems ? `, ${count("products")} items (stock set to 0)` : ""}.`);
    console.log("  A full backup is saved first.\n");
    const ans = await ask('  Type DELETE (in capital letters) to continue, or anything else to cancel: ');
    if (ans.trim() !== "DELETE") { console.log("  Cancelled. Nothing was changed."); process.exit(0); }
    const dir = path.join(DATA_DIR, "backups"); fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const file = path.join(dir, `before-reset-${stamp}.db`);
    await backupToFile(file);
    console.log(`  Backup saved: ${file}`);
    try {
      await db.tx(async (t) => {
        for (const x of ["payments", "day_closings", "orders", "sale_items", "sales", "stock_moves", "expenses", "customers", ...(keepItems ? [] : ["products"]), "audit"]) await t.run(`DELETE FROM ${x}`);
        await t.run(`DELETE FROM sqlite_sequence WHERE name IN (${["payments", "day_closings", "orders", "sale_items", "sales", "stock_moves", "expenses", "customers", ...(keepItems ? [] : ["products"]), "audit"].map((x) => `'${x}'`).join(",")})`);
        await t.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('seed_done', '1')");
      });
    } catch (e) { console.log("  Something went wrong. Nothing was changed: " + e.message); process.exit(1); }
    await log("data.reset", keepItems ? "all shop data deleted (items kept), users kept" : "all shop data deleted, users kept");
    if (!isRemote) await db.run("VACUUM");
    console.log("\n  Done. All shop data was deleted. User accounts and settings were kept.");
    console.log("  Start the app again with:  npm start");
    console.log("  To undo, stop the app and replace data\\grathia.db with the backup file above (renamed to grathia.db).\n");
  } else {
    console.log(`
  Grathia admin tool (works only on this computer)

    npm run admin -- list                         show all accounts
    npm run admin -- reset-password <username>    set a temporary password
    npm run admin -- make-admin <username>        make someone an administrator
    npm run admin -- unlock <username>            switch an account on
    npm run admin -- reset-data                   delete all shop data, keep user accounts
    npm run admin -- reset-data keep-items        same, but keep the item list and prices
`);
  }
  close();
})();
