# Grathia Sweet Haven — Shop Manager (secure edition)

A professional shop system for **Grathia Sweet Haven Bakery & Fresh Juice**:
point of sale with receipts, items and inventory, expenses, a daily day book,
profit reports, customers, staff accounts with roles, an audit log and backups.
Everything is saved in one database file on your computer.

---

## 1. Install (one time only)

1. **Node.js 22.13 or newer.** Go to <https://nodejs.org>, download the **LTS** version, install it.
2. **VS Code** from <https://code.visualstudio.com>.
3. **Unzip** `grathia-shop.zip`, for example into `Documents\grathia-shop`.

## 2. Run it in VS Code

1. VS Code → **File → Open Folder…** → choose `grathia-shop`.
2. **Terminal → New Terminal**.
3. First time only:
   ```
   npm install
   ```
4. Start the system:
   ```
   npm start
   ```
5. Open **http://localhost:3000** in your browser.

Or press **F5** in VS Code. To stop: click the terminal and press **Ctrl + C**.

## 3. First time

1. Click **Create account**. The **first account becomes the Administrator** automatically.
2. Log in. Go to **Items** → **Add item** for each thing you sell (and ingredients you use).
   Put the opening stock (how many you have now), the cost price and the selling price.
3. Check **Settings & backup**: shop details for receipts, payment methods, expense types.

## 4. The sidebar

| Section | What it does |
|---|---|
| **Dashboard** | Today's sales and expenses, month profit, 14-day sales chart, best sellers, low stock, latest receipts |
| **New sale** | Point of sale: tap items, change quantities, discount, customer, payment method → **printed receipt** with a number (e.g. R261124-001) |
| **Sales & receipts** | Every receipt by date; search; reprint; **cancel a sale** with a reason (managers) |
| **Items** | Add / edit items, item codes (SKU), categories, cost & selling price, margin, reorder level |
| **Inventory** | Stock levels and value; **Receive stock** (bought / made in kitchen / returned); **Used / damaged / expired**; **Stock count** to correct differences; full movement history per item |
| **Expenses** | Record and review spending by type |
| **Day book** | One day at a time: receipts, money by payment method, expenses, stock changes and **stock left at closing**. Printable. |
| **Reports** | Profit & loss, sales vs expenses chart, sales by item / category / payment / staff, **Export to Excel** |
| **Customers** | Customer list with visits and total spent |
| **Users & roles** | Approve sign-ups, set roles, switch accounts off, set temporary passwords, log people out |
| **Audit log** | Every action: who, what, when, from which device. Cannot be edited. |
| **Settings & backup** | Shop details, lists, auto log-out time, **download a full backup** |

## 5. Roles

| | Cashier | Manager | Administrator |
|---|:-:|:-:|:-:|
| Sales, receipts, stock in, losses, expenses, day book, customers | ✓ | ✓ | ✓ |
| Cost prices, profit, reports, Excel export | | ✓ | ✓ |
| Add / edit items and prices, change price at the till | | ✓ | ✓ |
| Cancel sales / expenses / stock changes, stock count | | ✓ | ✓ |
| Users, audit log, settings, backup | | | ✓ |

New staff click **Create account**; an administrator approves them in **Users & roles** and chooses their role.

## 6. Security features

- **Passwords** stored only as salted **scrypt** hashes. Minimum 8 characters with letters and numbers.
- **Lock-out**: 5 wrong passwords → that username and device are blocked for 15 minutes.
- **Sessions**: random 256-bit token in an HttpOnly, SameSite=Strict cookie; only its SHA-256 hash is stored.
  Auto log-out after inactivity (default 30 min, set in Settings) and after 7 days at most.
- **Approval**: new accounts cannot log in until an administrator approves them.
- **Permissions checked on the server** for every request (hiding buttons is not relied on).
  Cashiers never receive cost prices from the server.
- **Temporary passwords** set by an admin must be changed at next login. Changing a password logs out other devices.
- **CSRF protection** (custom request header + origin check + SameSite cookies).
- **Security headers**: Content-Security-Policy, X-Frame-Options (no click-jacking), nosniff, no-referrer.
- **Nothing is deleted**: sales, expenses and stock changes are only **cancelled with a reason**; all actions go to the audit log.
- **At least one active administrator** is always kept.
- All database queries use parameters (no SQL injection). All text shown on screen is escaped (no script injection).

## 7. Using it on phones in the shop

The terminal shows `On phones (same Wi-Fi): http://192.168.x.x:3000`. Phones on the **same Wi-Fi** can open that.
The computer must stay on. If Windows asks about the firewall, allow **Private networks** only.

> **Do not put this on the public internet as it is.** For access from outside the shop, it must run behind
> HTTPS (for example a reverse proxy such as Caddy or Nginx, with `TRUST_PROXY=1`). Ask a technical person.

## 8. Backups

- All data is in **`data/grathia.db`**.
- **Settings & backup → Download backup** saves a complete copy. Do it weekly; keep it on a USB stick or Google Drive.
- **Restore**: stop the app, replace `data/grathia.db` with your backup file (renamed to `grathia.db`), start again.

## 9. Folder contents

```
grathia-shop/
├── server.js        secure server: login, roles, sales, stock, reports, audit, backup
├── db.js            database tables + starting items
├── package.json     app settings (uses 2 libraries: express, exceljs)
├── public/
│   ├── index.html   page shell with the sidebar
│   ├── app.js       all screens
│   ├── app.css      design, light + dark mode
│   ├── theme.js     remembers light/dark choice
│   └── favicon.svg
├── .vscode/         press F5 to run
└── data/            your database (created on first start, not in the zip)
```

## 10. Problems?

- **"needs Node.js 22.13 or newer"** → install the latest LTS from nodejs.org, then restart VS Code.
- **`npm` is not recognised** → restart VS Code after installing Node.js.
- **Port 3000 in use** → it's already running in another terminal. Or on Windows: `set PORT=3001` then `npm start`.
- **"Too many wrong attempts"** → wait 15 minutes, or an administrator sets a new password (this also unlocks the username).
- **Lost the only admin password** → there is no back door (that's the security). Restore a backup, or delete `data/grathia.db` to start again from zero.
