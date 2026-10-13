require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const helo = require("./helo");
const billing = require("./billing");
const qrcode = require("qrcode");

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || "dev-secret";
const DB_FILE = path.join(__dirname, "data", "db.json");

// ---- UPI checkout: self-hosted, no payment service provider ----
// The client scans a UPI QR / taps a upi:// deep link, then confirms; the panel settles it.
const UPI_VPA = (process.env.UPI_VPA || "").trim();
const UPI_PAYEE_NAME = (process.env.UPI_PAYEE_NAME || process.env.BRAND_NAME || "SpeedTech.ai").trim();

// ---- tiny JSON "database" (swap for MySQL/Postgres later) ----
const db = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, "utf8"))
  : { users: [], contacts: [], campaigns: [], templates: [], settings: billing.defaultSettings(), plans: [], requests: [], txns: [], nextId: 1 };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const id = () => db.nextId++;

// Accepts 10-15 digits with an optional leading +, e.g. "+91 98765 43210" -> "+919876543210"
const normalizePhone = (p) => {
  let s = String(p || "").trim();
  s = s.startsWith("+") ? "+" + s.slice(1).replace(/\D/g, "") : s.replace(/\D/g, "");
  const digits = s.replace("+", "");
  return digits.length >= 10 && digits.length <= 15 ? s : null;
};

// one-time model change: buyer ("user") accounts and the product/order catalogue are
// gone; a client now message recipients directly. Anything "reseller" becomes "client".
// Idempotent, so it is safe to run on every boot.
let migrated = false;
(function migrateModel() {
  const before = db.users.length;
  db.users = db.users.filter((u) => u.role !== "user");
  if (db.users.length !== before) migrated = true;

  for (const u of db.users) {
    if (u.role === "reseller") { u.role = "client"; migrated = true; }
    if ("resellerId" in u) { delete u.resellerId; migrated = true; }
    if ("resellerCode" in u) { delete u.resellerCode; migrated = true; }
    if (!("phone" in u)) { u.phone = ""; migrated = true; }
  }
  for (const r of db.requests || []) {
    if ("resellerId" in r) { r.clientId = r.resellerId; delete r.resellerId; migrated = true; }
  }
  for (const c of db.campaigns || []) {
    if ("resellerId" in c) { c.clientId = c.resellerId; delete c.resellerId; migrated = true; }
  }
  if (db.products || db.orders) { delete db.products; delete db.orders; migrated = true; }
  if (!Array.isArray(db.contacts)) { db.contacts = []; migrated = true; }
  if (!Array.isArray(db.templates)) { db.templates = []; migrated = true; }
})();

// platform owner: seeded from env, never through the public sign-up form
if (process.env.ADMIN_EMAIL) {
  if (!process.env.ADMIN_PASSWORD) {
    console.warn("ADMIN_EMAIL is set but ADMIN_PASSWORD is not - skipping admin seed");
  } else if (!db.users.some((u) => u.role === "admin")) {
    db.users.push({ id: id(), name: process.env.ADMIN_NAME || "Platform owner", email: process.env.ADMIN_EMAIL,
      role: "admin", password: bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10), credits: 0, phone: "" });
    migrated = true;
  }
}

// billing collections, user fields and the one-time grandfathering of existing clients
if (billing.ensureBilling(db, id)) migrated = true;
if (migrated) save();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sign = (u) => jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: "7d" });
const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone || "", credits: u.credits,
  active: u.active !== false,
  // only a client carries a membership, and it is their own data
  ...(u.role === "client" ? { membership: billing.membershipState(u), onboardedAt: u.onboardedAt || null } : {}),
});
const txnSum = (type, side, wid) => db.txns.filter((t) => t.type === type && t[side] === wid).reduce((n, t) => n + t.credits, 0);
const payoutSum = (type, side, wid) => db.txns.filter((t) => t.type === type && t[side] === wid).reduce((n, t) => n + t.amountPaise, 0);
// a client row on the platform owner's screen. Deliberately no buyer counts any more.
const adminClient = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone || "", credits: u.credits,
  active: u.active !== false, billingType: u.billingType || "prepaid",
  onboardedAt: u.onboardedAt || null, lastTxnAt: u.lastTxnAt || null, wabaId: u.wabaId || "",
  membership: billing.membershipState(u),
  campaigns: db.campaigns.filter((c) => c.clientId === u.id).length,
  contacts: db.contacts.filter((c) => c.ownerId === u.id).length,
  templates: db.templates.filter((t) => t.ownerId === u.id).length,
  creditsPurchased: txnSum("purchase", "toId", u.id),
  creditsAssigned: txnSum("assign_reseller", "toId", u.id),
  creditsUsed: txnSum("spend", "fromId", u.id),
  revenuePaise: payoutSum("purchase", "toId", u.id),
  costPaise: db.txns.filter((t) => t.toId === u.id && ["purchase", "assign_reseller"].includes(t.type)).reduce((n, t) => n + t.costPaise, 0),
});

function auth(role) {
  return (req, res, next) => {
    try {
      const p = jwt.verify((req.headers.authorization || "").replace("Bearer ", ""), SECRET);
      req.user = db.users.find((u) => u.id === p.id);
      if (!req.user) throw new Error();
      if (role && req.user.role !== role) return res.status(403).json({ error: "Not allowed" });
      next();
    } catch { res.status(401).json({ error: "Please sign in" }); }
  };
}

app.get("/api/config", (_, res) => res.json({ brand: process.env.BRAND_NAME || "YourBrand", heloConnected: helo.configured() }));

// ---- auth ----
app.post("/api/auth/register", (req, res) => {
  const { name, email, password, signupCode } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password are required" });
  if (db.users.some((u) => u.email === email)) return res.status(400).json({ error: "Email already registered" });

  // guard: a blanked-out env code must not let anyone through
  const code = process.env.CLIENT_SIGNUP_CODE || process.env.RESELLER_SIGNUP_CODE;
  if (!code) return res.status(403).json({ error: "Sign-up is not open" });
  if (signupCode !== code) return res.status(403).json({ error: "Invalid signup code" });

  const user = { id: id(), name, email, role: "client",
    password: bcrypt.hashSync(password, 10), credits: 0, phone: "",
    active: true, billingType: "prepaid", onboardedAt: new Date().toISOString(),
    lastTxnAt: null, wabaId: "", planId: null, planStartedAt: null, planExpiresAt: null };
  db.users.push(user); save();
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post("/api/auth/login", (req, res) => {
  const u = db.users.find((x) => x.email === req.body.email);
  if (!u || !bcrypt.compareSync(req.body.password || "", u.password)) return res.status(401).json({ error: "Wrong email or password" });
  res.json({ token: sign(u), user: publicUser(u) });
});

app.get("/api/me", auth(), (req, res) => res.json(publicUser(req.user)));

app.patch("/api/me", auth(), (req, res) => {
  const { name, phone } = req.body;
  if (phone !== undefined) {
    // an empty string clears the sender number; anything else must be dialable
    const p = phone === "" ? "" : normalizePhone(phone);
    if (p === null) return res.status(400).json({ error: "Enter a valid phone number with country code (10-15 digits)" });
    req.user.phone = p;
  }
  if (name) req.user.name = String(name).slice(0, 80);
  save(); res.json(publicUser(req.user));
});

// ---- client: address book of the people they message ----
const contactView = (c) => ({ id: c.id, name: c.name || "", phone: c.phone, at: c.at });
const ownContact = (req, cid) => db.contacts.find((c) => c.id === cid && c.ownerId === req.user.id);

app.get("/api/client/contacts", auth("client"), (req, res) =>
  res.json(db.contacts.filter((c) => c.ownerId === req.user.id).map(contactView)));

app.post("/api/client/contacts", auth("client"), (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: "Enter a valid phone number with country code (10-15 digits)" });
  // one row per number per client, so re-adding a number just returns the existing contact
  const existing = db.contacts.find((c) => c.ownerId === req.user.id && c.phone === phone);
  if (existing) return res.json(contactView(existing));
  const c = { id: id(), ownerId: req.user.id, name: String(req.body.name || "").trim().slice(0, 80), phone, at: new Date().toISOString() };
  db.contacts.push(c); save(); res.json(contactView(c));
});

app.put("/api/client/contacts/:id", auth("client"), (req, res) => {
  const c = ownContact(req, +req.params.id);
  if (!c) return res.status(404).json({ error: "Contact not found" });
  if (req.body.name !== undefined) c.name = String(req.body.name).trim().slice(0, 80);
  if (req.body.phone !== undefined) {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: "Enter a valid phone number with country code (10-15 digits)" });
    c.phone = phone;
  }
  save(); res.json(contactView(c));
});

app.delete("/api/client/contacts/:id", auth("client"), (req, res) => {
  const i = db.contacts.findIndex((c) => c.id === +req.params.id && c.ownerId === req.user.id);
  if (i < 0) return res.status(404).json({ error: "Contact not found" });
  db.contacts.splice(i, 1); save(); res.json({ ok: true });
});

// ---- client: WhatsApp campaigns to the numbers they choose ----
app.get("/api/templates", auth(), async (_, res) => {
  try { res.json(await helo.listTemplates()); } catch (e) { res.status(502).json({ error: e.message }); }
});
// Templates the client types in by hand, so campaigns can still be built while the
// Helo template list is unreachable. Scoped per account; never touches Helo itself.
const customTemplate = (t) => ({ id: t.id, name: t.name, category: t.category, language: t.language,
  at: t.at, custom: true, status: "MANUAL" });
app.get("/api/templates/custom", auth(), (req, res) =>
  res.json(db.templates.filter((t) => t.ownerId === req.user.id).map(customTemplate)));
app.post("/api/templates/custom", auth(), (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Template name is required" });
  const t = { id: id(), ownerId: req.user.id, name: name.slice(0, 120),
    category: String(req.body.category || "MARKETING").trim().toUpperCase() || "MARKETING",
    language: String(req.body.language || "en").trim() || "en", at: new Date().toISOString() };
  db.templates.push(t); save(); res.json(customTemplate(t));
});
app.delete("/api/templates/custom/:id", auth(), (req, res) => {
  const i = db.templates.findIndex((t) => t.id === +req.params.id && t.ownerId === req.user.id);
  if (i < 0) return res.status(404).json({ error: "Template not found" });
  db.templates.splice(i, 1); save(); res.json({ ok: true });
});

// ---- platform owner: manage every client's WhatsApp templates from one place ----
const adminTemplate = (t) => {
  const o = db.users.find((u) => u.id === t.ownerId);
  return { ...customTemplate(t), ownerId: t.ownerId, owner: o ? o.name : "", email: o ? o.email : "" };
};
app.get("/api/admin/templates", auth("admin"), (req, res) => res.json(db.templates.map(adminTemplate)));
app.post("/api/admin/templates", auth("admin"), (req, res) => {
  const owner = db.users.find((u) => u.id === +req.body.ownerId && u.role === "client");
  if (!owner) return res.status(400).json({ error: "Choose a client" });
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Template name is required" });
  const t = { id: id(), ownerId: owner.id, name: name.slice(0, 120),
    category: String(req.body.category || "MARKETING").trim().toUpperCase() || "MARKETING",
    language: String(req.body.language || "en").trim() || "en", at: new Date().toISOString() };
  db.templates.push(t); save(); res.json(adminTemplate(t));
});
app.delete("/api/admin/templates/:id", auth("admin"), (req, res) => {
  const i = db.templates.findIndex((t) => t.id === +req.params.id);
  if (i < 0) return res.status(404).json({ error: "Template not found" });
  db.templates.splice(i, 1); save(); res.json({ ok: true });
});
// A campaign of N recipients is N single-send requests, so the request handler must not
// wait for the provider. Campaigns are recorded up front as "Sending" and a background
// worker finishes them, with credits deducted as each message is accepted.

app.get("/api/campaigns", auth("client"), (req, res) =>
  res.json(db.campaigns.filter((c) => c.clientId === req.user.id)));
app.post("/api/campaigns", auth("client"), async (req, res) => {
  const { name, templateName, templateCategory, templateLanguage, contactIds, numbers, params } = req.body;
  if (!name || !templateName) return res.status(400).json({ error: "Name and template are required" });
  // recipients come from two places: saved contacts picked by id, and numbers typed/pasted
  // in by hand. Both are resolved server-side and de-duplicated.
  const ids = Array.isArray(contactIds) ? contactIds.map(Number).filter(Number.isInteger) : [];
  const fromContacts = db.contacts
    .filter((c) => c.ownerId === req.user.id && ids.includes(c.id))
    .map((c) => c.phone);
  const typed = (Array.isArray(numbers) ? numbers : []).map(normalizePhone).filter(Boolean);
  const recipients = [...new Set([...fromContacts, ...typed])];
  if (!recipients.length) return res.status(400).json({ error: "Pick a contact or type at least one valid number" });
  // an expired or missing membership cannot send, when the platform requires one
  if (db.settings.requireMembership) {
    const m = billing.membershipState(req.user);
    if (!m || m.state !== "active")
      return res.status(402).json({ error: m && m.state === "expired"
        ? "Your membership has expired — renew it to send campaigns"
        : "No active membership — buy a plan to send campaigns" });
  }
  if (req.user.credits < recipients.length)
    return res.status(402).json({ error: `Not enough credits (need ${recipients.length}, have ${req.user.credits})` });

  const c = { id: id(), clientId: req.user.id, name: String(name).slice(0, 120), templateName: String(templateName),
    templateCategory: String(templateCategory || ""), templateLanguage: String(templateLanguage || "en"),
    recipients, total: recipients.length, accepted: 0, rejected: 0, delivered: 0, failed: 0,
    failures: [], status: "In-Draft", at: new Date().toISOString() };

  if (!helo.configured()) {
    // No credentials: behave as before so the whole flow stays testable offline.
    c.status = "Simulated";
    c.accepted = recipients.length;
    req.user.credits -= recipients.length;
    billing.logTxn(db, id, { type: "spend", fromId: req.user.id, credits: recipients.length,
      refType: "campaign", refId: c.id, note: c.name });
    req.user.lastTxnAt = new Date().toISOString();
    db.campaigns.push(c); save();
    return res.json({ campaign: c, credits: req.user.credits });
  }

  // Reserve the whole cost up front so concurrent campaigns cannot overdraw, then
  // refund each message Helo does not accept as the worker learns the outcome.
  req.user.credits -= recipients.length;
  c.status = "Sending";
  db.campaigns.push(c); save();
  res.json({ campaign: c, credits: req.user.credits });

  const owner = db.users.find((u) => u.id === c.clientId);
  const live = c;
  (async () => {
    let sinceSave = 0;
    try {
      const r = await helo.sendBulkTemplate({
        templateName: live.templateName, templateCategory: live.templateCategory,
        templateLanguage: live.templateLanguage, recipients: live.recipients, params,
        // the client's own sender number wins; HELO_FROM is the platform fallback
        from: owner ? owner.phone : "",
        onAccepted: () => {
          // The full cost is already reserved, so an accepted message simply keeps its
          // credit. Rejections are refunded in one pass when the campaign finishes.
          live.accepted += 1;
          if (++sinceSave >= 10) { sinceSave = 0; save(); }
        },
      });
      // A 500-recipient campaign would otherwise write 500 error strings into the DB.
      if (Array.isArray(r.results)) {
        for (const row of r.results) {
          if (row && row.accepted) continue;
          live.failed += 1;
          if (live.failures.length < 25) live.failures.push({ phone: row.phone, error: row.error });
          else if (live.failures.length === 25) live.failures.push({ phone: "", error: "further failures not listed" });
        }
      }
      live.rejected = live.total - live.accepted;
      live.status = live.accepted === 0 ? "Failed" : live.rejected ? "Partial" : "Sent";
    } catch (e) {
      live.status = "Failed";
      live.error = e.message;
    } finally {
      if (owner) {
        // Refund every message the provider did not take, so the client is only ever
        // charged for what actually went out.
        const refunded = live.total - live.accepted;
        owner.credits += refunded;
        if (live.accepted) billing.logTxn(db, id, { type: "spend", fromId: owner.id, credits: live.accepted,
          refType: "campaign", refId: live.id, note: live.name });
        if (refunded) billing.logTxn(db, id, { type: "refund", toId: owner.id, credits: refunded,
          refType: "campaign", refId: live.id, note: "provider rejected" });
        if (live.total) owner.lastTxnAt = new Date().toISOString();
        save();
      }
    }
  })();
});

// no-send health check: proves the credentials work before anyone sends a campaign
app.get("/api/helo/status", auth("admin"), async (req, res) => {
  try { res.json(await helo.health()); }
  catch (e) { res.status(502).json({ ok: false, error: e.message }); }
});

// ---- platform owner ----
app.get("/api/admin/clients", auth("admin"), (req, res) =>
  res.json(db.users.filter((u) => u.role === "client").map(adminClient)));
app.post("/api/admin/clients/:id/credits", auth("admin"), (req, res) => {
  const u = db.users.find((x) => x.id === +req.params.id && x.role === "client");
  if (!u) return res.status(404).json({ error: "Client not found" });
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount === 0) return res.status(400).json({ error: "Enter a whole number of credits to add or remove" });
  if (u.credits + amount < 0) return res.status(400).json({ error: `${u.name} only has ${u.credits} credits` });
  u.credits += amount;
  u.lastTxnAt = new Date().toISOString();
  // a manual grant has no money attached, but it still carries a cost basis for margin
  if (amount > 0) billing.logTxn(db, id, { type: "assign_reseller", fromId: req.user.id, toId: u.id, credits: amount,
    amountPaise: billing.creditsCost(amount, db.settings.creditBuyPricePaise),
    costPaise: billing.creditsCost(amount, db.settings.creditBuyPricePaise), refType: "manual", note: "admin grant" });
  else billing.logTxn(db, id, { type: "adjust", fromId: u.id, toId: req.user.id, credits: -amount, refType: "manual", note: "admin removal" });
  save(); res.json({ ...publicUser(u), adminClient: adminClient(u) });
});

// the platform owner can fix a client's connected sender number for them
app.patch("/api/admin/clients/:id", auth("admin"), (req, res) => {
  const u = db.users.find((x) => x.id === +req.params.id && x.role === "client");
  if (!u) return res.status(404).json({ error: "Client not found" });
  if (req.body.phone !== undefined) {
    const p = req.body.phone === "" ? "" : normalizePhone(req.body.phone);
    if (p === null) return res.status(400).json({ error: "Enter a valid phone number with country code (10-15 digits)" });
    u.phone = p;
  }
  if (req.body.name) u.name = String(req.body.name).slice(0, 80);
  if (req.body.active !== undefined) u.active = Boolean(req.body.active);
  save(); res.json(adminClient(u));
});

// a client's whole wallet on one screen: balance, ledger and payment history
app.get("/api/admin/clients/:id/wallet", auth("admin"), (req, res) => {
  const u = db.users.find((x) => x.id === +req.params.id && x.role === "client");
  if (!u) return res.status(404).json({ error: "Client not found" });
  res.json({
    client: publicUser(u), summary: adminClient(u),
    txns: db.txns.filter((t) => t.fromId === u.id || t.toId === u.id).reverse(),
    requests: db.requests.filter((r) => r.clientId === u.id).map(requestView).reverse(),
  });
});

// ---- pricing & membership plans ----
app.get("/api/admin/settings", auth("admin"), (req, res) =>
  res.json({ ...db.settings, plans: db.plans }));

app.patch("/api/admin/settings", auth("admin"), (req, res) => {
  const { creditBuyPricePaise, creditSellPricePaise, requireMembership } = req.body;
  const next = { ...db.settings };
  if (creditBuyPricePaise !== undefined) {
    const v = Number(creditBuyPricePaise);
    if (!Number.isInteger(v) || v <= 0) return res.status(400).json({ error: "Buy price must be a whole number of paise" });
    next.creditBuyPricePaise = v;
  }
  if (creditSellPricePaise !== undefined) {
    const v = Number(creditSellPricePaise);
    if (!Number.isInteger(v) || v <= 0) return res.status(400).json({ error: "Sell price must be a whole number of paise" });
    next.creditSellPricePaise = v;
  }
  if (next.creditSellPricePaise < next.creditBuyPricePaise)
    return res.status(400).json({ error: "Sell price cannot be below the buy price" });
  if (requireMembership !== undefined) next.requireMembership = Boolean(requireMembership);
  Object.assign(db.settings, next); save(); res.json(db.settings);
});

// a client only ever sees the sell price, never the platform's cost
app.get("/api/pricing", auth(), (req, res) =>
  res.json({ creditSellPricePaise: db.settings.creditSellPricePaise, plans: db.plans,
    payment: { provider: "upi", configured: Boolean(UPI_VPA), vpa: UPI_VPA || null, payeeName: UPI_PAYEE_NAME } }));

const parsePlan = (b) => {
  const name = String(b.name || "").trim();
  const months = Number(b.months);
  const pricePaise = Number(b.pricePaise);
  if (!name) return { error: "Plan name is required" };
  if (!Number.isInteger(months) || months < 1) return { error: "Months must be a positive whole number" };
  if (!Number.isInteger(pricePaise) || pricePaise <= 0) return { error: "Price must be a whole number of paise" };
  return { plan: { name: name.slice(0, 60), months, pricePaise } };
};
app.post("/api/admin/plans", auth("admin"), (req, res) => {
  const v = parsePlan(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const p = { id: id(), ...v.plan };
  db.plans.push(p); save(); res.json(p);
});
app.put("/api/admin/plans/:id", auth("admin"), (req, res) => {
  const p = db.plans.find((x) => x.id === +req.params.id);
  if (!p) return res.status(404).json({ error: "Plan not found" });
  const v = parsePlan(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  Object.assign(p, v.plan); save(); res.json(p);
});
app.delete("/api/admin/plans/:id", auth("admin"), (req, res) => {
  const i = db.plans.findIndex((x) => x.id === +req.params.id);
  if (i < 0) return res.status(404).json({ error: "Plan not found" });
  db.plans.splice(i, 1); save(); res.json({ ok: true });
});

// ---- purchase requests: a client raises one, the admin approves it ----
const requestView = (r) => ({
  ...r,
  plan: r.planId ? billing.planById(db, r.planId) : null,
  client: (() => { const u = db.users.find((x) => x.id === r.clientId); return u ? { id: u.id, name: u.name, email: u.email } : null; })(),
});

app.post("/api/client/requests", auth("client"), (req, res) => {
  const kind = req.body.kind === "membership" ? "membership" : "credits";
  const method = String(req.body.method || "manual").slice(0, 40);
  const note = String(req.body.note || "").slice(0, 300);
  let credits = 0, planId = null, amountPaise = 0;
  if (kind === "credits") {
    credits = Number(req.body.credits);
    if (!Number.isInteger(credits) || credits < 1) return res.status(400).json({ error: "Enter a whole number of credits" });
    amountPaise = billing.creditsCost(credits, db.settings.creditSellPricePaise);
  } else {
    const plan = billing.planById(db, req.body.planId);
    if (!plan) return res.status(400).json({ error: "Choose a membership plan" });
    planId = plan.id; amountPaise = plan.pricePaise;
  }
  // one open request at a time per client keeps the approval queue honest
  if (db.requests.some((r) => r.clientId === req.user.id && r.status === "pending"))
    return res.status(409).json({ error: "You already have a pending request" });
  const r = { id: id(), at: new Date().toISOString(), clientId: req.user.id, kind, credits, planId, amountPaise,
    status: "pending", method, note, decidedBy: null, decidedAt: null, decisionNote: "" };
  db.requests.push(r); save(); res.json(requestView(r));
});

app.get("/api/client/requests", auth("client"), (req, res) =>
  res.json(db.requests.filter((r) => r.clientId === req.user.id).map(requestView).reverse()));

// ---- UPI checkout ----
// quote: price the basket and hand back a upi:// intent + QR (never mutates).
// pay: settle on the client's confirmation. There is no PSP yet, so this is a
// self-reported UPI payment — the ledger records the reference for reconciliation.
const parseCheckout = (b) => {
  const kind = b.kind === "membership" ? "membership" : "credits";
  if (kind === "credits") {
    const credits = Number(b.credits);
    if (!Number.isInteger(credits) || credits < 1) return { error: "Enter a whole number of credits" };
    return { kind, credits, planId: null, amountPaise: billing.creditsCost(credits, db.settings.creditSellPricePaise) };
  }
  const plan = billing.planById(db, b.planId);
  if (!plan) return { error: "Choose a membership plan" };
  return { kind, credits: 0, planId: plan.id, amountPaise: plan.pricePaise };
};
function upiIntent(amountPaise, note) {
  if (!UPI_VPA) return null;
  const q = new URLSearchParams({ pa: UPI_VPA, pn: UPI_PAYEE_NAME, cu: "INR", am: (Number(amountPaise) / 100).toFixed(2) });
  if (note) q.set("tn", String(note).slice(0, 50));
  return "upi://pay?" + q.toString();
}
const checkoutLabel = (c) => c.kind === "credits" ? `${c.credits} credits`
  : `${(billing.planById(db, c.planId) || {}).name || "Membership"} membership`;

app.post("/api/client/checkout/quote", auth("client"), async (req, res) => {
  const c = parseCheckout(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  const uri = upiIntent(c.amountPaise, `SpeedTech ${checkoutLabel(c)}`);
  res.json({ ...c, label: checkoutLabel(c), payment: { provider: "upi", configured: Boolean(UPI_VPA),
    vpa: UPI_VPA || null, payeeName: UPI_PAYEE_NAME, uri, qr: uri ? await qrcode.toDataURL(uri, { margin: 1, width: 260 }) : null } });
});

app.post("/api/client/checkout/pay", auth("client"), (req, res) => {
  const c = parseCheckout(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  const ref = String(req.body.ref || "").slice(0, 60);
  const now = new Date().toISOString();
  const u = req.user;
  if (c.kind === "credits") {
    u.credits += c.credits;
    billing.logTxn(db, id, { type: "purchase", fromId: null, toId: u.id, credits: c.credits,
      amountPaise: c.amountPaise, costPaise: billing.creditsCost(c.credits, db.settings.creditBuyPricePaise),
      refType: "checkout", refId: ref || null, note: `UPI credit purchase${ref ? " · " + ref : ""}` });
  } else {
    const plan = billing.planById(db, c.planId);
    u.planId = plan.id;
    u.planStartedAt = u.planStartedAt || now;
    u.planExpiresAt = billing.nextExpiry(u.planExpiresAt, plan.months);
    billing.logTxn(db, id, { type: "membership", fromId: null, toId: u.id, credits: 0,
      amountPaise: c.amountPaise, costPaise: 0, refType: "checkout", refId: ref || null,
      note: `UPI membership ${plan.name}${ref ? " · " + ref : ""}` });
  }
  u.lastTxnAt = now;
  // recorded in the request history so the platform owner can reconcile the UPI reference
  const r = { id: id(), at: now, clientId: u.id, kind: c.kind, credits: c.kind === "credits" ? c.credits : 0,
    planId: c.kind === "membership" ? c.planId : null, amountPaise: c.amountPaise, status: "approved",
    method: "UPI", note: ref, decidedBy: null, decidedAt: now, decisionNote: "auto-settled via UPI" };
  db.requests.push(r); save();
  res.json({ ok: true, credits: u.credits, membership: billing.membershipState(u), request: requestView(r) });
});

app.get("/api/admin/requests", auth("admin"), (req, res) => {
  const status = req.query.status;
  const list = status ? db.requests.filter((r) => r.status === status) : db.requests;
  res.json(list.map(requestView).reverse());
});

app.post("/api/admin/requests/:id/approve", auth("admin"), (req, res) => {
  const r = db.requests.find((x) => x.id === +req.params.id);
  if (!r) return res.status(404).json({ error: "Request not found" });
  if (r.status !== "pending") return res.status(409).json({ error: "Already decided" });
  const u = db.users.find((x) => x.id === r.clientId && x.role === "client");
  if (!u) return res.status(404).json({ error: "Client not found" });
  const now = new Date().toISOString();
  if (r.kind === "credits") {
    u.credits += r.credits;
    billing.logTxn(db, id, { type: "purchase", fromId: req.user.id, toId: u.id, credits: r.credits,
      amountPaise: r.amountPaise, costPaise: billing.creditsCost(r.credits, db.settings.creditBuyPricePaise),
      refType: "request", refId: r.id, note: "approved credit purchase" });
  } else {
    const plan = billing.planById(db, r.planId) || db.plans[0];
    u.planId = plan ? plan.id : null;
    u.planStartedAt = u.planStartedAt || now;
    u.planExpiresAt = billing.nextExpiry(u.planExpiresAt, plan ? plan.months : 1);
    billing.logTxn(db, id, { type: "membership", fromId: req.user.id, toId: u.id, credits: 0,
      amountPaise: r.amountPaise, costPaise: 0, refType: "request", refId: r.id, note: `membership ${plan ? plan.name : ""}` });
  }
  u.lastTxnAt = now;
  r.status = "approved"; r.decidedBy = req.user.id; r.decidedAt = now;
  r.decisionNote = String(req.body.note || "").slice(0, 300);
  save(); res.json(requestView(r));
});

app.post("/api/admin/requests/:id/reject", auth("admin"), (req, res) => {
  const r = db.requests.find((x) => x.id === +req.params.id);
  if (!r) return res.status(404).json({ error: "Request not found" });
  if (r.status !== "pending") return res.status(409).json({ error: "Already decided" });
  r.status = "rejected"; r.decidedBy = req.user.id; r.decidedAt = new Date().toISOString();
  r.decisionNote = String(req.body.note || "").slice(0, 300);
  save(); res.json(requestView(r));
});

// ---- ledger ----
app.get("/api/admin/txns", auth("admin"), (req, res) => res.json([...db.txns].reverse()));
app.get("/api/client/txns", auth("client"), (req, res) =>
  res.json(db.txns.filter((t) => t.fromId === req.user.id || t.toId === req.user.id).reverse()));

// client dashboard: the numbers behind the stat cards
app.get("/api/client/stats", auth("client"), (req, res) => {
  const cid = req.user.id;
  const mine = db.campaigns.filter((c) => c.clientId === cid);
  res.json({
    contacts: db.contacts.filter((c) => c.ownerId === cid).length,
    campaigns: mine.length,
    recipients: mine.reduce((n, c) => n + (c.total || 0), 0),
    sent: mine.reduce((n, c) => n + (c.accepted || 0), 0),
    creditsPurchased: txnSum("purchase", "toId", cid),
    creditsAssigned: txnSum("assign_reseller", "toId", cid),
    creditsUsed: txnSum("spend", "fromId", cid),
    creditsAvailable: req.user.credits,
  });
});

// ---- anything unexpected gets the same JSON shape as everything else ----
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong" });
});

const server = app.listen(PORT, () => console.log(`Panel running on http://localhost:${PORT}`));

// A second copy of the panel is a common mistake, and under `node --watch` the raw
// EADDRINUSE stack trace is all you get. Say what actually happened instead.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use, so this copy of the panel did not start.`);
    console.error("Something else is already listening there - usually an earlier \`npm run dev\`.");
    console.error(`Close it, or start this one on another port:  PORT=3001 npm run dev\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
