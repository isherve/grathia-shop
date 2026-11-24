// Shop time zone helpers. Servers such as Vercel run in UTC, but the shop's days
// follow Rwanda time. Change with the SHOP_TZ environment variable.
"use strict";
const SHOP_TZ = process.env.SHOP_TZ || "Africa/Kigali";
const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: SHOP_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: SHOP_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: SHOP_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

const localDate = (d = new Date()) => dateFmt.format(d);              // "YYYY-MM-DD" in shop time
const timeHM = (t) => (t ? timeFmt.format(new Date(t)) : "");          // "HH:MM" in shop time
function offsetMs(t) {                                                // shop time minus UTC at moment t
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(t)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
const dayStart = (d) => { const u = Date.parse(d + "T00:00:00Z"); return u - offsetMs(u); }; // first ms of shop day d
const dayEnd = (d) => dayStart(d) + 864e5 - 1;                                                // last ms of shop day d

module.exports = { SHOP_TZ, localDate, timeHM, dayStart, dayEnd };
