require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const helo = require("./helo");
const billing = require("./billing");
const qrcode = require("qrcode");

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || "dev-secret";
const DB_FILE = path.join(__dirname, "data", "db.json");
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");

// ---- UPI checkout: self-hosted, no payment service provider ----
// The reseller scans a UPI QR / taps a upi:// deep link, then confirms; the panel settles it.
const UPI_VPA = (process.env.UPI_VPA || "").trim();
const UPI_PAYEE_NAME = (process.env.UPI_PAYEE_NAME || process.env.BRAND_NAME || "SpeedTech.ai").trim();

// ---- tiny JSON "database" (swap for MySQL/Postgres later) ----
const db = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, "utf8"))
  : { users: [], products: [], orders: [], campaigns: [], settings: billing.defaultSettings(), plans: [], requests: [], txns: [], nextId: 1 };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const id = () => db.nextId++;

// ---- reseller codes: random, unguessable, stored per reseller ----
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I, so it survives being read aloud
const CODE_LEN = 6;
const normalizeCode = (c) => String(c || "").trim().toUpperCase();
const validCode = (c) => /^[A-Z0-9][A-Z0-9-]{2,10}[A-Z0-9]$/.test(c);
const newCode = () => {
  for (;;) {
    let c = "";
    for (let i = 0; i < CODE_LEN; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!db.users.some((u) => u.resellerCode === c)) return c;
  }
};

// Accepts 10-15 digits with an optional leading +, e.g. "+91 98765 43210" -> "+919876543210"
const normalizePhone = (p) => {
  let s = String(p || "").trim();
  s = s.startsWith("+") ? "+" + s.slice(1).replace(/\D/g, "") : s.replace(/\D/g, "");
  const digits = s.replace("+", "");
  return digits.length >= 10 && digits.length <= 15 ? s : null;
};

// ---- product images ----
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const IMAGE_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp", "image/gif": ".gif" };
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${IMAGE_EXT[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, Boolean(IMAGE_EXT[file.mimetype])),
});
const dropImage = (name) => { if (name) fs.unlink(path.join(UPLOAD_DIR, path.basename(name)), () => {}); };

// one-time migration: resellers created before custom codes keep their old R<id> code
let migrated = false;
for (const u of db.users) {
  if (u.role === "reseller" && !u.resellerCode) { u.resellerCode = "R" + u.id; migrated = true; }
}

// platform owner: seeded from env, never through the public sign-up form
if (process.env.ADMIN_EMAIL) {
  if (!process.env.ADMIN_PASSWORD) {
    console.warn("ADMIN_EMAIL is set but ADMIN_PASSWORD is not - skipping admin seed");
  } else if (!db.users.some((u) => u.role === "admin")) {
    db.users.push({ id: id(), name: process.env.ADMIN_NAME || "Platform owner", email: process.env.ADMIN_EMAIL,
      role: "admin", password: bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10), credits: 0,
      resellerId: null, resellerCode: null, phone: "" });
    migrated = true;
  }
}

// billing collections, user fields and the one-time grandfathering of existing resellers
if (billing.ensureBilling(db, id)) migrated = true;
if (migrated) save();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sign = (u) => jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: "7d" });
const publicUser = (u) => {
  const linked = db.users.find((x) => x.id === u.resellerId);
  return { id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone || "", credits: u.credits, resellerId: u.resellerId,
    active: u.active !== false,
    // resellers see their own code; buyers see the code of the reseller they signed up under
    resellerCode: u.role === "reseller" ? u.resellerCode : linked && linked.resellerCode,
    // only a reseller carries a membership, and it is their own data
    ...(u.role === "reseller" ? { membership: billing.membershipState(u), onboardedAt: u.onboardedAt || null } : {}) };
};
// a customer row on the reseller dashboard. Deliberately no buy price / margin here.
const customerRow = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone || "",
  credits: u.credits, active: u.active !== false, billingType: u.billingType || "prepaid",
  onboardedAt: u.onboardedAt || null, lastTxnAt: u.lastTxnAt || null, wabaId: u.wabaId || "" });
const txnSum = (type, side, wid) => db.txns.filter((t) => t.type === type && t[side] === wid).reduce((n, t) => n + t.credits, 0);
const payoutSum = (type, side, wid) => db.txns.filter((t) => t.type === type && t[side] === wid).reduce((n, t) => n + t.amountPaise, 0);
const adminReseller = (u) => ({
  ...customerRow(u), resellerCode: u.resellerCode, membership: billing.membershipState(u),
  customers: db.users.filter((x) => x.resellerId === u.id).length,
  campaigns: db.campaigns.filter((c) => c.resellerId === u.id).length,
  revenue: db.orders.filter((o) => o.resellerId === u.id && o.status !== "cancelled").reduce((n, o) => n + o.amount, 0),
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
  const { name, email, password, role = "user", resellerCode, signupCode, phone } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Name, email and password are required" });
  if (role === "admin") return res.status(403).json({ error: "Admin accounts are created by the platform owner" });
  if (db.users.some((u) => u.email === email)) return res.status(400).json({ error: "Email already registered" });

  const isReseller = role === "reseller";
  let resellerId = null;
  let phoneOut = "";
  if (isReseller) {
    // guard: a blanked-out env code must not let anyone through
    if (!process.env.RESELLER_SIGNUP_CODE) return res.status(403).json({ error: "Reseller sign-up is not open" });
    if (signupCode !== process.env.RESELLER_SIGNUP_CODE) return res.status(403).json({ error: "Invalid reseller signup code" });
  } else {
    const r = db.users.find((u) => u.role === "reseller" && u.resellerCode === normalizeCode(resellerCode));
    if (!r) return res.status(400).json({ error: "Valid reseller code required" });
    resellerId = r.id;
    const p = normalizePhone(phone);
    if (!p) return res.status(400).json({ error: "A valid phone number with country code is required" });
    phoneOut = p;
  }
  const user = { id: id(), name, email, role: isReseller ? "reseller" : "user",
    password: bcrypt.hashSync(password, 10), credits: 0, resellerId,
    resellerCode: isReseller ? newCode() : null, phone: phoneOut,
    active: true, billingType: "prepaid", onboardedAt: new Date().toISOString(),
    lastTxnAt: null, wabaId: "",
    ...(isReseller ? { planId: null, planStartedAt: null, planExpiresAt: null } : {}) };
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
    if (req.user.role !== "user") return res.status(403).json({ error: "Only buyers keep a phone number here" });
    const p = normalizePhone(phone);
    if (!p) return res.status(400).json({ error: "Enter a valid phone number with country code (10-15 digits)" });
    req.user.phone = p;
  }
  if (name) req.user.name = String(name).slice(0, 80);
  save(); res.json(publicUser(req.user));
});

// ---- reseller: change their own customer-facing code ----
app.patch("/api/me/reseller-code", auth("reseller"), (req, res) => {
  const code = normalizeCode(req.body.resellerCode);
  if (!validCode(code)) return res.status(400).json({ error: "Code must be 4-12 letters, numbers or hyphens" });
  if (db.users.some((u) => u.role === "reseller" && u.resellerCode === code && u.id !== req.user.id))
    return res.status(409).json({ error: "That code is already taken" });
  req.user.resellerCode = code; save();
  res.json(publicUser(req.user));
});

// ---- reseller: product catalogue ----
app.get("/api/products", auth(), (req, res) => {
  const rid = req.user.role === "reseller" ? req.user.id : req.user.resellerId;
  res.json(db.products.filter((p) => p.resellerId === rid));
});
app.post("/api/products", auth("reseller"), upload.single("image"), (req, res) => {
  // an empty price field must not silently become a free product
  if (!req.body.name || String(req.body.price ?? "").trim() === "")
    return res.status(400).json({ error: "Name and a valid price are required" });
  const price = Number(req.body.price);
  if (!(price >= 0) || Number.isNaN(price)) return res.status(400).json({ error: "Enter a valid price" });
  const p = { id: id(), resellerId: req.user.id, name: String(req.body.name).slice(0, 120),
    description: String(req.body.description || "").slice(0, 2000), price, image: req.file ? req.file.filename : "" };
  db.products.push(p); save(); res.json(p);
});
app.put("/api/products/:id", auth("reseller"), upload.single("image"), (req, res) => {
  const p = db.products.find((x) => x.id === +req.params.id && x.resellerId === req.user.id);
  if (!p) return res.status(404).json({ error: "Product not found" });
  if (req.body.name) p.name = String(req.body.name).slice(0, 120);
  if (req.body.description !== undefined) p.description = String(req.body.description).slice(0, 2000);
  if (req.body.price !== undefined) {
    if (String(req.body.price).trim() === "") return res.status(400).json({ error: "Enter a valid price" });
    const price = Number(req.body.price);
    if (!(price >= 0) || Number.isNaN(price)) return res.status(400).json({ error: "Enter a valid price" });
    p.price = price;
  }
  if (req.file) { dropImage(p.image); p.image = req.file.filename; }
  save(); res.json(p);
});
app.delete("/api/products/:id", auth("reseller"), (req, res) => {
  const i = db.products.findIndex((x) => x.id === +req.params.id && x.resellerId === req.user.id);
  if (i < 0) return res.status(404).json({ error: "Product not found" });
  dropImage(db.products[i].image);
  db.products.splice(i, 1); save(); res.json({ ok: true });
});
app.get("/api/reseller/users", auth("reseller"), (req, res) =>
  res.json(db.users.filter((u) => u.resellerId === req.user.id).map(customerRow)));

// ---- buyer: order a product (no credits involved; payment gateway = TODO) ----
app.post("/api/orders", auth("user"), (req, res) => {
  const p = db.products.find((x) => x.id === +req.body.productId && x.resellerId === req.user.resellerId);
  if (!p) return res.status(404).json({ error: "Product not found" });
  // TODO: create payment (Razorpay/UPI) and mark the order paid only after it succeeds
  const o = { id: id(), userId: req.user.id, resellerId: p.resellerId, productId: p.id,
    productName: p.name, amount: p.price, status: "pending", at: new Date().toISOString() };
  db.orders.push(o); save(); res.json({ order: o });
});
app.patch("/api/orders/:id", auth("reseller"), (req, res) => {
  const o = db.orders.find((x) => x.id === +req.params.id && x.resellerId === req.user.id);
  if (!o) return res.status(404).json({ error: "Order not found" });
  const status = String(req.body.status || "");
  if (!["pending", "fulfilled", "cancelled"].includes(status)) return res.status(400).json({ error: "Unknown status" });
  o.status = status; save(); res.json(o);
});
app.get("/api/orders", auth(), (req, res) => {
  const list = req.user.role === "admin" ? db.orders
    : req.user.role === "reseller" ? db.orders.filter((o) => o.resellerId === req.user.id)
    : db.orders.filter((o) => o.userId === req.user.id);
  res.json(list.map((o) => ({ ...o, productName: o.productName || (db.products.find((p) => p.id === o.productId) || {}).name })));
});

// ---- reseller: WhatsApp campaigns to his own buyers ----
app.get("/api/templates", auth(), async (_, res) => {
  try { res.json(await helo.listTemplates()); } catch (e) { res.status(502).json({ error: e.message }); }
});
// A campaign of N recipients is N single-send requests, so the request handler must not
// wait for the provider. Campaigns are recorded up front as "Sending" and a background
// worker finishes them, with credits deducted as each message is accepted.

app.get("/api/campaigns", auth("reseller"), (req, res) =>
  res.json(db.campaigns.filter((c) => c.resellerId === req.user.id)));
app.post("/api/campaigns", auth("reseller"), async (req, res) => {
  const { name, templateName, templateCategory, templateLanguage, customerIds, params } = req.body;
  if (!name || !templateName) return res.status(400).json({ error: "Name and template are required" });
  const ids = Array.isArray(customerIds) ? customerIds.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: "Pick at least one customer" });
  // ids are mapped to phone numbers server-side so a reseller can only ever
  // message their own buyers, whatever the client sends
  const recipients = [...new Set(db.users
    .filter((u) => u.resellerId === req.user.id && ids.includes(u.id) && u.phone)
    .map((u) => u.phone))];
  if (!recipients.length) return res.status(400).json({ error: "None of the selected customers have a phone number" });
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

  const c = { id: id(), resellerId: req.user.id, name: String(name).slice(0, 120), templateName: String(templateName),
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

  const owner = db.users.find((u) => u.id === c.resellerId);
  const live = c;
  (async () => {
    let sinceSave = 0;
    try {
      const r = await helo.sendBulkTemplate({
        templateName: live.templateName, templateCategory: live.templateCategory,
        templateLanguage: live.templateLanguage, recipients: live.recipients, params,
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
        // Refund every message the provider did not take, so the reseller is only ever
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
app.get("/api/admin/resellers", auth("admin"), (req, res) =>
  res.json(db.users.filter((u) => u.role === "reseller").map(adminReseller)));
app.post("/api/admin/resellers/:id/credits", auth("admin"), (req, res) => {
  const u = db.users.find((x) => x.id === +req.params.id && x.role === "reseller");
  if (!u) return res.status(404).json({ error: "Reseller not found" });
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
  save(); res.json({ ...publicUser(u), adminReseller: adminReseller(u) });
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

// a reseller only ever sees the sell price, never the platform's cost
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

// ---- purchase requests: a reseller raises one, the admin approves it ----
const requestView = (r) => ({
  ...r,
  plan: r.planId ? billing.planById(db, r.planId) : null,
  reseller: (() => { const u = db.users.find((x) => x.id === r.resellerId); return u ? { id: u.id, name: u.name, email: u.email } : null; })(),
});

app.post("/api/reseller/requests", auth("reseller"), (req, res) => {
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
  // one open request at a time per reseller keeps the approval queue honest
  if (db.requests.some((r) => r.resellerId === req.user.id && r.status === "pending"))
    return res.status(409).json({ error: "You already have a pending request" });
  const r = { id: id(), at: new Date().toISOString(), resellerId: req.user.id, kind, credits, planId, amountPaise,
    status: "pending", method, note, decidedBy: null, decidedAt: null, decisionNote: "" };
  db.requests.push(r); save(); res.json(requestView(r));
});

app.get("/api/reseller/requests", auth("reseller"), (req, res) =>
  res.json(db.requests.filter((r) => r.resellerId === req.user.id).map(requestView).reverse()));

// ---- UPI checkout ----
// quote: price the basket and hand back a upi:// intent + QR (never mutates).
// pay: settle on the reseller's confirmation. There is no PSP yet, so this is a
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

app.post("/api/reseller/checkout/quote", auth("reseller"), async (req, res) => {
  const c = parseCheckout(req.body);
  if (c.error) return res.status(400).json({ error: c.error });
  const uri = upiIntent(c.amountPaise, `SpeedTech ${checkoutLabel(c)}`);
  res.json({ ...c, label: checkoutLabel(c), payment: { provider: "upi", configured: Boolean(UPI_VPA),
    vpa: UPI_VPA || null, payeeName: UPI_PAYEE_NAME, uri, qr: uri ? await qrcode.toDataURL(uri, { margin: 1, width: 260 }) : null } });
});

app.post("/api/reseller/checkout/pay", auth("reseller"), (req, res) => {
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
  const r = { id: id(), at: now, resellerId: u.id, kind: c.kind, credits: c.kind === "credits" ? c.credits : 0,
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
  const u = db.users.find((x) => x.id === r.resellerId && x.role === "reseller");
  if (!u) return res.status(404).json({ error: "Reseller not found" });
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
app.get("/api/reseller/txns", auth("reseller"), (req, res) =>
  res.json(db.txns.filter((t) => t.fromId === req.user.id || t.toId === req.user.id).reverse()));

// reseller dashboard: the numbers behind the stat cards
app.get("/api/reseller/stats", auth("reseller"), (req, res) => {
  const rid = req.user.id;
  const users = db.users.filter((u) => u.resellerId === rid);
  res.json({
    users: users.length,
    active: users.filter((u) => u.active !== false).length,
    inactive: users.filter((u) => u.active === false).length,
    creditsPurchased: txnSum("purchase", "toId", rid),
    creditsAssignedReseller: txnSum("assign_reseller", "toId", rid),
    creditsAssignedUser: txnSum("assign_user", "toId", rid),
    creditsUsedReseller: txnSum("spend", "fromId", rid),
    creditsUsedUser: 0,
    creditsAvailable: req.user.credits,
  });
});

// ---- image upload errors (multer) get the same JSON shape as everything else ----
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Image must be 5MB or smaller" });
  if (err && err.code === "LIMIT_UNEXPECTED_FILE") return res.status(400).json({ error: "Unexpected file field" });
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
