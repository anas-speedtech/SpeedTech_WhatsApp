// One-off data migration for the client-focused model (run once, safe to re-run):
//   node migrate.js
// Stop the server first - it keeps its own copy of the data in memory and will
// overwrite data/db.json on its next write.
//
// This drops the buyer ("user") accounts and the product/order catalogue, renames
// everything "reseller" to "client", and adds the per-client contacts list.
const fs = require("fs");
const path = require("path");
const billing = require("./billing");

const DB_FILE = path.join(__dirname, "data", "db.json");
const db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
let changed = 0;
let nid = db.nextId;
const nextId = () => nid++;

// buyer accounts (and, with them, the whole "user" concept) are gone
const usersBefore = db.users.length;
db.users = db.users.filter((u) => u.role !== "user");
changed += usersBefore - db.users.length;

// products / orders are gone
if (db.products) { delete db.products; changed++; }
if (db.orders) { delete db.orders; changed++; }

// reseller -> client everywhere
for (const u of db.users) {
  if (u.role === "reseller") { u.role = "client"; changed++; }
  if ("resellerId" in u) { delete u.resellerId; changed++; }
  if ("resellerCode" in u) { delete u.resellerCode; changed++; }
  if (!("phone" in u)) { u.phone = ""; changed++; }
}
for (const r of db.requests || []) {
  if (r.resellerId !== undefined) { r.clientId = r.resellerId; delete r.resellerId; changed++; }
}
for (const c of db.campaigns || []) {
  if (c.resellerId !== undefined) { c.clientId = c.resellerId; delete c.resellerId; changed++; }
  if (c.userId !== undefined && c.clientId === undefined) { c.clientId = c.userId; delete c.userId; changed++; }
  // Helo needs a template category and language alongside the name, and we track
  // what the provider accepted vs rejected at send time.
  if (!Array.isArray(c.recipients)) { c.recipients = []; changed++; }
  if (typeof c.delivered !== "number") { c.delivered = 0; changed++; }
  if (typeof c.failed !== "number") { c.failed = 0; changed++; }
  if (!("templateCategory" in c)) { c.templateCategory = ""; changed++; }
  if (!("templateLanguage" in c)) { c.templateLanguage = "en"; changed++; }
  if (typeof c.accepted !== "number") { c.accepted = c.status === "Simulated" ? (c.total || 0) : 0; changed++; }
  if (typeof c.rejected !== "number") { c.rejected = 0; changed++; }
}

// a client's own address book, and the hand-typed templates collection
if (!Array.isArray(db.contacts)) { db.contacts = []; changed++; }
if (!Array.isArray(db.templates)) { db.templates = []; changed++; }

// billing: pricing, plans, requests, ledger, and the user fields the dashboard reads
changed += billing.ensureBilling(db, nextId);
db.nextId = nid;

fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
console.log(`migration done: ${changed} field(s) updated`);
console.log(`  users ${db.users.length}, contacts ${db.contacts.length}, campaigns ${db.campaigns.length}`);
console.log(`  settings buy ${billing.perCredit(db.settings.creditBuyPricePaise)}/credit, sell ${billing.perCredit(db.settings.creditSellPricePaise)}/credit, plans ${db.plans.length}, requests ${db.requests.length}, txns ${db.txns.length}`);
