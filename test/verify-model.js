const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const PROJ = path.join(__dirname, "..");
const UPLOADS = path.join(PROJ, "public", "uploads");
// This suite writes to the real data/db.json, so it snapshots first and restores on the way
// out. Running it must never leave a developer's accounts and campaigns overwritten.
const DB_FILE = path.join(PROJ, "data", "db.json");
const DB_BACKUP = DB_FILE + ".verify-model-backup";
// Snapshot whatever is there, then start from an empty database. Several assertions count
// pre-existing rows, and the admin only seeds when no admin exists, so a leftover file
// from another run would silently break this suite.
const snapshotDb = () => {
  if (fs.existsSync(DB_FILE)) { fs.copyFileSync(DB_FILE, DB_BACKUP); fs.unlinkSync(DB_FILE); }
};
const restoreDb = () => {
  try {
    if (fs.existsSync(DB_BACKUP)) { fs.copyFileSync(DB_BACKUP, DB_FILE); fs.unlinkSync(DB_BACKUP); console.log("db.json restored"); }
    else { fs.unlinkSync(DB_FILE); console.log("no db.json existed before this run, removed the one it created"); }
  } catch (e) { console.log("could not restore db.json: " + e.message); }
};
// This suite starts its own server with Helo deliberately UNCONFIGURED, so campaigns take
// the simulated path. It must not inherit the developer's .env, or a locally configured
// HELO_BASE_URL would turn these into live-send tests.
const PORT = Number(process.env.PORT || 3106);
const BASE = "http://127.0.0.1:" + PORT;
const SIGNUP = "test-signup-code";
// Generated per run so no real credential is ever committed, and the suite can never
// sign in to a real account if it is pointed at the wrong server.
const ADMIN = { email: "test-admin@example.test",
  password: "test-admin-pw-" + require("crypto").randomBytes(8).toString("hex") };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let pass = 0, fail = 0, server = null;
const ok = (n, c, e) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : " -> " + JSON.stringify(e))); };

// Start the panel ourselves with Helo blanked out, so this suite never reads the developer's
// .env and never turns into a live-send test when HELO_BASE_URL happens to be set locally.
const startServer = () => new Promise((resolve, reject) => {
  // Helo blanked so sends simulate; the admin and signup code are supplied here because
  // the suite must not depend on a developer's local .env being present.
  const blank = { HELO_BASE_URL: "", HELO_USER_ID: "", HELO_API_KEY: "", HELO_PASSWORD: "",
    HELO_FROM: "", HELO_WABA_ID: "", JWT_SECRET: "test-secret", BRAND_NAME: "SpeedTech.ai",
    RESELLER_SIGNUP_CODE: SIGNUP, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password };
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PROJ, env: { ...process.env, ...blank, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (b) => { err += b; });
  const t = setTimeout(() => reject(new Error("server did not start: " + err)), 20000);
  child.stdout.on("data", (b) => {
    if (String(b).includes("Panel running")) { clearTimeout(t); server = child; resolve(); }
  });
  child.on("exit", (code) => { clearTimeout(t); reject(new Error("server exited " + code + ": " + err)); });
});

async function call(p, method, body, token) {
  const res = await fetch(BASE + p, { method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const reg = (b) => call("/api/auth/register", "POST", b);

function productForm(fields, file) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (file) fd.append("image", new Blob([file.buf], { type: file.type }), file.name);
  return fd;
}
async function upload(p, method, fields, token, file) {
  const res = await fetch(BASE + p, { method, headers: token ? { Authorization: "Bearer " + token } : {}, body: productForm(fields, file) });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  const s = Date.now();
  snapshotDb();
  // if the suite throws part way through, the real data still has to come back
  process.on("exit", () => { if (server) { try { server.kill(); } catch {} } restoreDb(); });
  await startServer();

  // ---------- roles ----------
  const admin = await call("/api/auth/login", "POST", ADMIN);
  ok("admin logs in from .env seed", admin.status === 200 && admin.data.user.role === "admin", admin.data);
  const A = admin.data.token;

  const noPhone = await reg({ name: "NoPhone", email: "np@" + s, password: "secret123", role: "user", resellerCode: "R1" });
  ok("buyer signup without a phone is rejected (400)", noPhone.status === 400, noPhone);
  const badPhone = await reg({ name: "BadPhone", email: "bp@" + s, password: "secret123", role: "user", resellerCode: "R1", phone: "123" });
  ok("buyer signup with a 3-digit phone is rejected (400)", badPhone.status === 400, badPhone);
  const spoof = await reg({ name: "Sneaky", email: "sn@" + s, password: "secret123", role: "admin" });
  ok("public signup cannot self-register an admin (403)", spoof.status === 403, spoof);

  const res1 = await reg({ name: "Seller One", email: "s1@" + s, password: "secret123", role: "reseller", signupCode: SIGNUP });
  const T1 = res1.data.token, R1 = res1.data.user;
  ok("reseller registers", res1.status === 200, res1.data);

  const buy1 = await reg({ name: "Buyer One", email: "b1@" + s, password: "secret123", role: "user", resellerCode: R1.resellerCode, phone: "+91 98765 43210" });
  const B1 = buy1.data.token;
  ok("buyer registers and phone is normalised", buy1.status === 200 && buy1.data.user.phone === "+919876543210", buy1.data);

  const res2 = await reg({ name: "Seller Two", email: "s2@" + s, password: "secret123", role: "reseller", signupCode: SIGNUP });
  const T2 = res2.data.token, R2 = res2.data.user;
  const buy2 = await reg({ name: "Buyer Two", email: "b2@" + s, password: "secret123", role: "user", resellerCode: R2.resellerCode, phone: "919999999999" });
  const B2 = buy2.data.token, U2 = buy2.data.user;

  // ---------- catalogue ----------
  const noImg = await upload("/api/products", "POST", { name: "Plain Item", description: "No picture", price: "250" }, T1);
  ok("reseller adds a product with no image", noImg.status === 200 && noImg.data.image === "" && noImg.data.credits === undefined, noImg.data);
  const withImg = await upload("/api/products", "POST", { name: "Widget", description: "Shiny", price: "99.5" }, T1, { buf: PNG, type: "image/png", name: "w.png" });
  ok("reseller adds a product with an image", withImg.status === 200 && /\.png$/.test(withImg.data.image || ""), withImg.data);
  ok("uploaded file exists on disk", fs.existsSync(path.join(UPLOADS, withImg.data.image)), withImg.data.image);

  const badType = await upload("/api/products", "POST", { name: "Evil", price: "1" }, T1, { buf: Buffer.from("not an image"), type: "text/plain", name: "x.txt" });
  ok("a non-image upload is ignored, not stored", badType.status === 200 && badType.data.image === "", badType.data);
  ok("non-image file was not written to disk", !fs.existsSync(path.join(UPLOADS, "x.txt")));

  const tooBig = await upload("/api/products", "POST", { name: "Huge", price: "1" }, T1, { buf: Buffer.alloc(6 * 1024 * 1024), type: "image/png", name: "h.png" });
  ok("an image over 5MB is rejected with a clean 413", tooBig.status === 413, tooBig);

  const noPrice = await upload("/api/products", "POST", { name: "Priceless", price: "" }, T1);
  ok("product without a price is rejected (400)", noPrice.status === 400, noPrice);
  const freeProduct = await upload("/api/products", "POST", { name: "Freebie", price: "0" }, T1);
  ok("an explicit 0 price is allowed", freeProduct.status === 200 && freeProduct.data.price === 0, freeProduct.data);
  const buyerPost = await upload("/api/products", "POST", { name: "Nope", price: "10" }, B1);
  ok("a buyer cannot create products (403)", buyerPost.status === 403, buyerPost);

  const edit = await upload("/api/products/" + withImg.data.id, "PUT", { name: "Widget Pro", price: "149" }, T1);
  ok("reseller edits a product", edit.status === 200 && edit.data.name === "Widget Pro" && edit.data.price === 149, edit.data);
  const otherEdit = await upload("/api/products/" + withImg.data.id, "PUT", { name: "Hijacked", price: "1" }, T2);
  ok("a reseller cannot edit another reseller's product (404)", otherEdit.status === 404, otherEdit);

  const cat1 = await call("/api/products", "GET", null, B1);
  ok("buyer sees only their reseller's products", cat1.data.length === 4 && cat1.data.every((p) => p.resellerId === R1.id), cat1.data.map((p) => p.name));
  const cat2 = await call("/api/products", "GET", null, B2);
  ok("buyer of another reseller sees none of those", cat2.data.length === 0, cat2.data);

  // ---------- orders grant no credits ----------
  const order = await call("/api/orders", "POST", { productId: noImg.data.id }, B1);
  ok("buyer places an order", order.status === 200 && order.data.order.status === "pending", order.data);
  const me1 = await call("/api/me", "GET", null, B1);
  ok("ordering does NOT grant the buyer any credits", me1.data.credits === 0, me1.data);
  const order2 = await call("/api/orders", "POST", { productId: withImg.data.id }, B1);
  ok("buyer can order again", order2.status === 200, order2.data);
  const crossOrder = await call("/api/orders", "POST", { productId: noImg.data.id }, B2);
  ok("buyer cannot order from another reseller (404)", crossOrder.status === 404, crossOrder);
  const resOrder = await call("/api/orders", "POST", { productId: noImg.data.id }, T1);
  ok("a reseller cannot order products (403)", resOrder.status === 403, resOrder);

  const incoming = await call("/api/orders", "GET", null, T1);
  ok("reseller sees incoming orders", incoming.data.length === 2, incoming.data.length);
  const buyerOrders = await call("/api/orders", "GET", null, B1);
  ok("buyer sees only their own orders", buyerOrders.data.length === 2, buyerOrders.data.length);
  const badStatus = await call("/api/orders/" + order.data.order.id, "PATCH", { status: "weird" }, T1);
  ok("unknown order status rejected (400)", badStatus.status === 400, badStatus);
  const fulfil = await call("/api/orders/" + order.data.order.id, "PATCH", { status: "fulfilled" }, T1);
  ok("reseller marks an order fulfilled", fulfil.status === 200 && fulfil.data.status === "fulfilled", fulfil.data);
  const otherFulfil = await call("/api/orders/" + order.data.order.id, "PATCH", { status: "cancelled" }, T2);
  ok("a reseller cannot touch another reseller's order (404)", otherFulfil.status === 404, otherFulfil);

  // ---------- admin grants credits ----------
  const adminDenied = await call("/api/admin/resellers", "GET", null, T1);
  ok("reseller cannot list resellers (403)", adminDenied.status === 403, adminDenied);
  const zero = await call("/api/admin/resellers/" + R1.id + "/credits", "POST", { amount: 0 }, A);
  ok("granting 0 credits is rejected (400)", zero.status === 400, zero);
  const frac = await call("/api/admin/resellers/" + R1.id + "/credits", "POST", { amount: 1.5 }, A);
  ok("fractional credits are rejected (400)", frac.status === 400, frac);
  const overdraw = await call("/api/admin/resellers/" + R1.id + "/credits", "POST", { amount: -5 }, A);
  ok("deducting below zero is rejected (400)", overdraw.status === 400, overdraw);
  const grant = await call("/api/admin/resellers/" + R1.id + "/credits", "POST", { amount: 5 }, A);
  ok("admin grants 5 credits", grant.status === 200 && grant.data.credits === 5, grant.data);
  const grantAgain = await call("/api/admin/resellers/" + R1.id + "/credits", "POST", { amount: 1 }, A);
  ok("credits accumulate", grantAgain.data.credits === 6, grantAgain.data);
  const take = await call("/api/admin/resellers/" + R1.id + "/credits", "POST", { amount: -2 }, A);
  ok("admin removes credits", take.status === 200 && take.data.credits === 4, take.data);
  const grantUser = await call("/api/admin/resellers/" + buy1.data.user.id + "/credits", "POST", { amount: 10 }, A);
  ok("admin cannot grant credits to a buyer (404)", grantUser.status === 404, grantUser);

  // Counted relative to what this run created, not a fixed number, so the assertion does
  // not depend on whatever happened to be in data/db.json beforehand.
  const adminOrders = await call("/api/orders", "GET", null, A);
  ok("admin sees every order in the database", adminOrders.data.length === 2, adminOrders.data.length);

  // ---------- membership is required to send ----------
  const plans = (await call("/api/pricing", "GET", null, T1)).data.plans;
  const mreq = await call("/api/reseller/requests", "POST", { kind: "membership", planId: plans[0].id }, T1);
  ok("reseller requests a membership plan", mreq.status === 200 && mreq.data.kind === "membership", mreq.data);
  const mapp = await call("/api/admin/requests/" + mreq.data.id + "/approve", "POST", {}, A);
  ok("admin approves the membership, activating it", mapp.status === 200 && mapp.data.status === "approved", mapp.data);
  const mstate = await call("/api/me", "GET", null, T1);
  ok("reseller membership is now active", mstate.data.membership && mstate.data.membership.state === "active", mstate.data.membership);

  // ---------- campaigns: reseller only, own buyers only ----------
  const buyerCamp = await call("/api/campaigns", "GET", null, B1);
  ok("buyer cannot list campaigns (403)", buyerCamp.status === 403, buyerCamp);
  const buyerSend = await call("/api/campaigns", "POST", { name: "x", templateName: "demo_template", customerIds: [buy1.data.user.id] }, B1);
  ok("buyer cannot send campaigns (403)", buyerSend.status === 403, buyerSend);

  const noIds = await call("/api/campaigns", "POST", { name: "x", templateName: "t", customerIds: [] }, T1);
  ok("campaign with nobody selected is rejected (400)", noIds.status === 400, noIds);

  const foreign = await call("/api/campaigns", "POST", { name: "Steal", templateName: "demo_template", customerIds: [U2.id] }, T1);
  ok("reseller cannot campaign to another reseller's buyer (400)", foreign.status === 400, foreign);

  const cur = (await call("/api/me", "GET", null, T1)).data.credits;
  const drain = await call("/api/admin/resellers/" + R1.id + "/credits", "POST", { amount: -cur }, A);
  ok("reseller balance drains to exactly 0", drain.status === 200 && drain.data.credits === 0, drain.data);

  const tooFew = await call("/api/campaigns", "POST", { name: "Big", templateName: "demo_template", customerIds: [buy1.data.user.id] }, T1);
  ok("campaign blocked when out of credits (402)", tooFew.status === 402, tooFew.data);

  await call("/api/admin/resellers/" + R1.id + "/credits", "POST", { amount: 50 }, A);
  const sent = await call("/api/campaigns", "POST", { name: "Spring sale", templateName: "demo_template", customerIds: [buy1.data.user.id] }, T1);
  ok("reseller campaigns to own buyer", sent.status === 200 && sent.data.campaign.total === 1, sent.data);
  ok("1 credit spent per recipient", sent.data.credits === 49, sent.data.credits);
  ok("recipient phone resolved server-side", sent.data.campaign.recipients[0] === "+919876543210", sent.data.campaign.recipients);

  const meT1 = await call("/api/me", "GET", null, T1);
  ok("campaign appears in reseller history", (await call("/api/campaigns", "GET", null, T1)).data.length === 1, meT1.data.credits);
  const seenByBuyer = await call("/api/campaigns", "GET", null, B1);
  ok("buyer still cannot see campaigns (403)", seenByBuyer.status === 403, seenByBuyer);

  // ---------- phone editing ----------
  const badEdit = await call("/api/me", "PATCH", { phone: "12" }, B1);
  ok("invalid phone rejected on edit (400)", badEdit.status === 400, badEdit);
  const goodEdit = await call("/api/me", "PATCH", { phone: "+1 555 010 9999" }, B1);
  ok("buyer edits their phone", goodEdit.status === 200 && goodEdit.data.phone === "+15550109999", goodEdit.data);
  const resPhone = await call("/api/me", "PATCH", { phone: "+919999999999" }, T1);
  ok("a reseller has no phone to set (403)", resPhone.status === 403, resPhone);

  // buyer with no phone cannot be targeted
  const noPhoneUser = await reg({ name: "Landline", email: "ln@" + s, password: "secret123", role: "user", resellerCode: R1.resellerCode, phone: "12345" });
  ok("signup with an unusable phone is rejected", noPhoneUser.status === 400, noPhoneUser.data);

  // ---------- helo health check (admin only, and it must never send) ----------
  const heloReseller = await call("/api/helo/status", "GET", null, T1);
  ok("reseller cannot read the helo health check (403)", heloReseller.status === 403, heloReseller);
  const heloAdmin = await call("/api/helo/status", "GET", null, A);
  ok("admin health check runs without credentials and explains why", heloAdmin.status === 200
    && heloAdmin.data.ok === false && /HELO_BASE_URL/.test(heloAdmin.data.reason), heloAdmin.data);
  const cfg = await call("/api/config", "GET", null, A);
  ok("config reports Helo as not connected while unconfigured", cfg.status === 200
    && cfg.data.heloConnected === false, cfg.data);
  const heloAnon = await call("/api/helo/status", "GET");
  ok("health check needs a token (401)", heloAnon.status === 401, heloAnon);

  // ---------- campaign records the new Helo fields ----------
  // the reseller had 49 credits after the previous campaign, so 48 is expected after this one
  const shaped = await call("/api/campaigns", "POST", { name: "Shaped", templateName: "promo",
    templateCategory: "MARKETING", templateLanguage: "hi", customerIds: [buy1.data.user.id] }, T1);
  ok("campaign stores the template category and language", shaped.status === 200
    && shaped.data.campaign.templateCategory === "MARKETING" && shaped.data.campaign.templateLanguage === "hi", shaped.data.campaign);
  ok("simulated campaign is marked accepted and simulated", shaped.data.campaign.status === "Simulated"
    && shaped.data.campaign.accepted === 1 && shaped.data.campaign.rejected === 0, shaped.data.campaign);
  const simulatedCredits = await call("/api/me", "GET", null, T1);
  ok("a simulated campaign still charges the reseller", simulatedCredits.data.credits === 48, simulatedCredits.data.credits);
  ok("delivery counters start at zero for DLR later", shaped.data.campaign.delivered === 0
    && shaped.data.campaign.failed === 0, shaped.data.campaign);

  // ---------- cleanup of the test product ----------
  const del = await call("/api/products/" + withImg.data.id, "DELETE", null, T1);
  ok("reseller deletes a product", del.status === 200, del);
  const gone = fs.existsSync(path.join(UPLOADS, withImg.data.image));
  ok("deleting a product removes its image from disk", !gone, gone);

  console.log("\n" + pass + " passed, " + fail + " failed");
  // the exit handler tears down the server and restores data/db.json
  process.exit(fail ? 1 : 0);
})();
