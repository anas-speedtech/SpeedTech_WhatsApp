// One-off data migration for the product-model change (run once, safe to re-run):
//   node migrate.js
// Stop the server first - it keeps its own copy of the data in memory and will
// overwrite data/db.json on its next write.
const fs = require("fs");
const path = require("path");
const billing = require("./billing");

const DB_FILE = path.join(__dirname, "data", "db.json");
const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
let changed = 0;
let nid = db.nextId;
const nextId = () => nid++;

// products: credit packs -> catalogue items with an image
for (const p of db.products) {
  if ("credits" in p) { delete p.credits; changed++; }
  if (!("description" in p)) p.description = "";
  if (!("image" in p)) p.image = "";
}

// orders: gain a status, and a product name snapshot so history survives renames
const STATUSES = ["pending", "fulfilled", "cancelled"];
for (const o of db.orders) {
  if (!o.status || !STATUSES.includes(o.status)) { o.status = "pending"; changed++; }
  if (!o.productName) o.productName = (db.products.find((p) => p.id === o.productId) || {}).name || "Removed product";
}

// users: every account carries a phone (only buyers ever use it)
for (const u of db.users) {
  if (!("phone" in u)) { u.phone = ""; changed++; }
}

// campaigns: renamed owner field for the reseller-only model
for (const c of db.campaigns) {
  if (c.userId !== undefined && c.resellerId === undefined) { c.resellerId = c.userId; delete c.userId; changed++; }
  if (!Array.isArray(c.recipients)) { c.recipients = []; changed++; }
  if (typeof c.delivered !== "number") { c.delivered = 0; changed++; }
  if (typeof c.failed !== "number") { c.failed = 0; changed++; }
  // Helo needs a template category and language alongside the name, and we now
  // track what the provider accepted vs rejected at send time.
  if (!("templateCategory" in c)) { c.templateCategory = ""; changed++; }
  if (!("templateLanguage" in c)) { c.templateLanguage = "en"; changed++; }
  if (typeof c.accepted !== "number") { c.accepted = c.status === "Simulated" ? (c.total || 0) : 0; changed++; }
  if (typeof c.rejected !== "number") { c.rejected = 0; changed++; }
}

// billing: pricing, plans, requests, ledger, and the user fields the dashboard reads
changed += billing.ensureBilling(db, nextId);
db.nextId = nid;

fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
console.log(`migration done: ${changed} field(s) updated`);
console.log(`  products ${db.products.length}, orders ${db.orders.length}, users ${db.users.length}, campaigns ${db.campaigns.length}`);
console.log(`  settings buy ${billing.perCredit(db.settings.creditBuyPricePaise)}/credit, sell ${billing.perCredit(db.settings.creditSellPricePaise)}/credit, plans ${db.plans.length}, requests ${db.requests.length}, txns ${db.txns.length}`);
const noPhone = db.users.filter((u) => u.role === "user" && !u.phone).map((u) => u.email);
if (noPhone.length) console.log(`  buyers with no phone yet (cannot be campaign targets): ${noPhone.join(", ")}`);
