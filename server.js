require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const helo = require("./helo");

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || "dev-secret";
const DB_FILE = path.join(__dirname, "data", "db.json");
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");

// ---- tiny JSON "database" (swap for MySQL/Postgres later) ----
const db = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, "utf8"))
  : { users: [], products: [], orders: [], campaigns: [], nextId: 1 };
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
// data/ is not in version control (only db.json is gitignored, and it is the sole file
// in that folder), so a fresh clone has no data/ at all. Create both up front, otherwise
// the first save() below throws ENOENT on a clean checkout.
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
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
if (migrated) save();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const sign = (u) => jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: "7d" });
const publicUser = (u) => {
  const linked = db.users.find((x) => x.id === u.resellerId);
  return { id: u.id, name: u.name, email: u.email, role: u.role, phone: u.phone || "", credits: u.credits, resellerId: u.resellerId,
    // resellers see their own code; buyers see the code of the reseller they signed up under
    resellerCode: u.role === "reseller" ? u.resellerCode : linked && linked.resellerCode };
};

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
    resellerCode: isReseller ? newCode() : null, phone: phoneOut };
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
  res.json(db.users.filter((u) => u.resellerId === req.user.id).map(publicUser)));

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
        owner.credits += live.total - live.accepted;
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
  res.json(db.users.filter((u) => u.role === "reseller").map((u) => ({ ...publicUser(u),
    customers: db.users.filter((x) => x.resellerId === u.id).length,
    campaigns: db.campaigns.filter((c) => c.resellerId === u.id).length,
    revenue: db.orders.filter((o) => o.resellerId === u.id).reduce((n, o) => n + o.amount, 0) }))));
app.post("/api/admin/resellers/:id/credits", auth("admin"), (req, res) => {
  const u = db.users.find((x) => x.id === +req.params.id && x.role === "reseller");
  if (!u) return res.status(404).json({ error: "Reseller not found" });
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount === 0) return res.status(400).json({ error: "Enter a whole number of credits to add or remove" });
  if (u.credits + amount < 0) return res.status(400).json({ error: `${u.name} only has ${u.credits} credits` });
  u.credits += amount; save(); res.json(publicUser(u));
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
