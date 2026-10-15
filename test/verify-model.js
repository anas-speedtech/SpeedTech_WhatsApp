const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const PROJ = path.join(__dirname, "..");
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

(async () => {
  const s = Date.now();
  snapshotDb();
  // if the suite throws part way through, the real data still has to come back
  process.on("exit", () => { if (server) { try { server.kill(); } catch {} } restoreDb(); });
  await startServer();

  // ---------- roles ----------
  const admin = await call("/api/auth/login", "POST", ADMIN);
  ok("admin logs in from .env seed", admin.status === 200 && admin.data.user.role === "admin", admin.data);
  const A = admin.data.token, ADMIN_USER = admin.data.user;

  const noCode = await reg({ name: "NoCode", email: "nc@" + s, password: "secret123" });
  ok("signup without a code is refused (403)", noCode.status === 403, noCode);
  const badCode = await reg({ name: "BadCode", email: "bc@" + s, password: "secret123", signupCode: "nope" });
  ok("signup with a wrong code is refused (403)", badCode.status === 403, badCode);
  const spoof = await reg({ name: "Sneaky", email: "sn@" + s, password: "secret123", signupCode: SIGNUP, role: "admin" });
  ok("public signup cannot self-register an admin", spoof.status === 200 && spoof.data.user.role === "client", spoof.data);
  const legacy = await reg({ name: "Legacy", email: "lg@" + s, password: "secret123", signupCode: SIGNUP, role: "user" });
  ok("a legacy 'user' role signup is just a client", legacy.status === 200 && legacy.data.user.role === "client", legacy.data);

  const c1 = await reg({ name: "Client One", email: "c1@" + s, password: "secret123", signupCode: SIGNUP });
  const T1 = c1.data.token, C1 = c1.data.user;
  ok("client registers", c1.status === 200 && C1.role === "client", c1.data);
  ok("a new client has no membership yet", !C1.membership || C1.membership.state === "none", C1.membership);
  ok("the client response carries no reseller code", C1.resellerCode === undefined, C1);

  const c2 = await reg({ name: "Client Two", email: "c2@" + s, password: "secret123", signupCode: SIGNUP });
  const T2 = c2.data.token, C2 = c2.data.user;

  // ---------- contacts ----------
  const badAdd = await call("/api/client/contacts", "POST", { name: "No phone" }, T1);
  ok("a contact needs a phone number (400)", badAdd.status === 400, badAdd.data);
  const badPhone = await call("/api/client/contacts", "POST", { phone: "123" }, T1);
  ok("a 3-digit phone is rejected (400)", badPhone.status === 400, badPhone.data);

  const a1 = await call("/api/client/contacts", "POST", { name: "Asha", phone: "+91 98765 43210" }, T1);
  ok("client adds a contact, phone normalised", a1.status === 200 && a1.data.phone === "+919876543210", a1.data);
  const dup = await call("/api/client/contacts", "POST", { name: "Asha again", phone: "+919876543210" }, T1);
  ok("re-adding the same number returns the existing contact", dup.status === 200 && dup.data.id === a1.data.id, dup.data);
  const a2 = await call("/api/client/contacts", "POST", { phone: "919999999999" }, T1);
  ok("a bare 12-digit number is accepted", a2.status === 200 && a2.data.phone === "919999999999", a2.data);

  const book1 = await call("/api/client/contacts", "GET", null, T1);
  ok("client lists their own contacts", book1.data.length === 2, book1.data);
  const book2 = await call("/api/client/contacts", "GET", null, T2);
  ok("another client sees none of them", book2.status === 200 && book2.data.length === 0, book2.data);
  const steal = await call("/api/client/contacts/" + a1.data.id, "DELETE", null, T2);
  ok("another client cannot delete a contact (404)", steal.status === 404, steal.data);
  const renamed = await call("/api/client/contacts/" + a1.data.id, "PUT", { name: "Asha P" }, T1);
  ok("client renames a contact", renamed.status === 200 && renamed.data.name === "Asha P", renamed.data);

  const contactGet = await call("/api/client/contacts", "GET", null, A);
  ok("the platform owner cannot read contacts (403)", contactGet.status === 403, contactGet);

  // ---------- admin grants credits ----------
  const adminDenied = await call("/api/admin/clients", "GET", null, T1);
  ok("a client cannot list clients (403)", adminDenied.status === 403, adminDenied);
  const zero = await call("/api/admin/clients/" + C1.id + "/credits", "POST", { amount: 0 }, A);
  ok("granting 0 credits is rejected (400)", zero.status === 400, zero);
  const frac = await call("/api/admin/clients/" + C1.id + "/credits", "POST", { amount: 1.5 }, A);
  ok("fractional credits are rejected (400)", frac.status === 400, frac);
  const overdraw = await call("/api/admin/clients/" + C1.id + "/credits", "POST", { amount: -5 }, A);
  ok("deducting below zero is rejected (400)", overdraw.status === 400, overdraw);
  const grant = await call("/api/admin/clients/" + C1.id + "/credits", "POST", { amount: 5 }, A);
  ok("admin grants 5 credits", grant.status === 200 && grant.data.credits === 5, grant.data);
  const take = await call("/api/admin/clients/" + C1.id + "/credits", "POST", { amount: -2 }, A);
  ok("admin removes credits", take.status === 200 && take.data.credits === 3, take.data);
  const grantAdmin = await call("/api/admin/clients/" + ADMIN_USER.id + "/credits", "POST", { amount: 10 }, A);
  ok("admin cannot grant credits to a non-client (404)", grantAdmin.status === 404, grantAdmin);

  // ---------- membership is required to send ----------
  const plans = (await call("/api/pricing", "GET", null, T1)).data.plans;
  const noMember = await call("/api/campaigns", "POST", { name: "x", templateName: "t", contactIds: [a1.data.id] }, T1);
  ok("a client with no membership cannot send (402)", noMember.status === 402 && /membership/i.test(noMember.data.error || ""), noMember.data);

  const mreq = await call("/api/client/requests", "POST", { kind: "membership", planId: plans[0].id }, T1);
  ok("client requests a membership plan", mreq.status === 200 && mreq.data.kind === "membership", mreq.data);
  const mapp = await call("/api/admin/requests/" + mreq.data.id + "/approve", "POST", {}, A);
  ok("admin approves the membership, activating it", mapp.status === 200 && mapp.data.status === "approved", mapp.data);
  const mstate = await call("/api/me", "GET", null, T1);
  ok("client membership is now active", mstate.data.membership && mstate.data.membership.state === "active", mstate.data.membership);

  // ---------- campaigns: a client messages the numbers they choose ----------
  const adminCamp = await call("/api/campaigns", "GET", null, A);
  ok("the platform owner cannot list campaigns (403)", adminCamp.status === 403, adminCamp);

  const noRecip = await call("/api/campaigns", "POST", { name: "Empty", templateName: "t" }, T1);
  ok("a campaign with nobody chosen is rejected (400)", noRecip.status === 400, noRecip);
  const badOnly = await call("/api/campaigns", "POST", { name: "Bad", templateName: "t", numbers: ["bad", "12"] }, T1);
  ok("a campaign with only invalid numbers is rejected (400)", badOnly.status === 400, badOnly.data);

  await call("/api/admin/clients/" + C1.id + "/credits", "POST", { amount: 50 }, A);
  const beforeSend = (await call("/api/me", "GET", null, T1)).data.credits;
  const sent = await call("/api/campaigns", "POST", { name: "Spring sale", templateName: "demo_template",
    contactIds: [a1.data.id], numbers: ["+919876500001", "+919876543210", "nonsense"] }, T1);
  ok("a client sends to chosen contacts + pasted numbers", sent.status === 200 && sent.data.campaign.total === 2, sent.data);
  ok("invalid pasted numbers are dropped, and duplicates removed", sent.data.campaign.recipients.length === 2
    && sent.data.campaign.recipients.includes("+919876543210") && sent.data.campaign.recipients.includes("+919876500001"), sent.data.campaign.recipients);
  ok("1 credit is spent per recipient", sent.data.credits === beforeSend - 2, { credits: sent.data.credits, beforeSend });
  ok("recipient phone resolved server-side", sent.data.campaign.recipients.includes("+919876543210"), sent.data.campaign.recipients);
  ok("simulated campaign is marked accepted", sent.data.campaign.status === "Simulated" && sent.data.campaign.accepted === 2, sent.data.campaign);

  const mine = await call("/api/campaigns", "GET", null, T1);
  ok("the campaign appears in the client's history", mine.data.length === 1, mine.data);

  // ---------- stats ----------
  const stats = await call("/api/client/stats", "GET", null, T1);
  ok("stats count the client's contacts", stats.data.contacts === 2, stats.data);
  ok("stats count campaigns and messages", stats.data.campaigns === 1 && stats.data.sent === 2, stats.data);
  ok("stats total spent credits", stats.data.creditsUsed === 2, stats.data);
  const stats2 = await call("/api/client/stats", "GET", null, T2);
  ok("another client's stats are empty", stats2.data.campaigns === 0 && stats2.data.contacts === 0, stats2.data);

  // out of credits blocks the send
  const cur = (await call("/api/me", "GET", null, T1)).data.credits;
  const drain = await call("/api/admin/clients/" + C1.id + "/credits", "POST", { amount: -cur }, A);
  ok("client balance drains to exactly 0", drain.status === 200 && drain.data.credits === 0, drain.data);
  const tooFew = await call("/api/campaigns", "POST", { name: "Big", templateName: "demo_template",
    numbers: ["+919876500001"] }, T1);
  ok("campaign blocked when out of credits (402)", tooFew.status === 402, tooFew.data);

  // ---------- campaign records the Helo template shape ----------
  await call("/api/admin/clients/" + C1.id + "/credits", "POST", { amount: 10 }, A);
  const shaped = await call("/api/campaigns", "POST", { name: "Shaped", templateName: "promo",
    templateCategory: "MARKETING", templateLanguage: "hi", numbers: ["+919876500001"] }, T1);
  ok("campaign stores the template category and language", shaped.status === 200
    && shaped.data.campaign.templateCategory === "MARKETING" && shaped.data.campaign.templateLanguage === "hi", shaped.data.campaign);
  ok("delivery counters start at zero for DLR later", shaped.data.campaign.delivered === 0
    && shaped.data.campaign.failed === 0, shaped.data.campaign);

  // ---------- sender number (a client's own WhatsApp number) ----------
  const badEdit = await call("/api/me", "PATCH", { phone: "12" }, T1);
  ok("invalid sender number rejected on edit (400)", badEdit.status === 400, badEdit);
  const goodEdit = await call("/api/me", "PATCH", { phone: "+91 98700 11111" }, T1);
  ok("client sets their sender number, normalised", goodEdit.status === 200 && goodEdit.data.phone === "+919870011111", goodEdit.data);
  const clearEdit = await call("/api/me", "PATCH", { phone: "" }, T1);
  ok("client can clear the sender number", clearEdit.status === 200 && clearEdit.data.phone === "", clearEdit.data);

  // ---------- hand-added templates (fallback while Helo's list is unreachable) ----------
  const cnone = await call("/api/templates/custom", "GET", null, T1);
  ok("no hand-added templates to start", cnone.status === 200 && cnone.data.length === 0, cnone.data);
  const cbad = await call("/api/templates/custom", "POST", { name: "   " }, T1);
  ok("a hand-added template needs a name (400)", cbad.status === 400, cbad.data);
  const cadd = await call("/api/templates/custom", "POST", { name: "ismotors_client", language: "English" }, T1);
  ok("client adds a template by hand", cadd.status === 200 && cadd.data.name === "ismotors_client"
    && cadd.data.custom === true && cadd.data.category === "MARKETING", cadd.data);
  const clist = await call("/api/templates/custom", "GET", null, T1);
  ok("hand-added template is listed for its owner", clist.data.length === 1 && clist.data[0].id === cadd.data.id, clist.data);
  const cOther = await call("/api/templates/custom", "GET", null, T2);
  ok("another account does not see it", cOther.status === 200 && cOther.data.length === 0, cOther.data);
  const cSteal = await call("/api/templates/custom/" + cadd.data.id, "DELETE", null, T2);
  ok("another account cannot delete it (404)", cSteal.status === 404, cSteal.data);
  const cdel = await call("/api/templates/custom/" + cadd.data.id, "DELETE", null, T1);
  ok("owner deletes the hand-added template", cdel.status === 200 && cdel.data.ok === true, cdel.data);

  // ---------- platform owner: manage a client's templates, sender number and wallet ----------
  const atDenied = await call("/api/admin/templates", "GET", null, T1);
  ok("a client cannot list every client's templates (403)", atDenied.status === 403, atDenied);
  const awadd = await call("/api/admin/templates", "POST", { ownerId: C1.id, name: "owner_made", category: "UTILITY", language: "hi" }, A);
  ok("admin adds a template on behalf of a client", awadd.status === 200 && awadd.data.name === "owner_made"
    && awadd.data.ownerId === C1.id && awadd.data.owner === "Client One", awadd.data);
  const awbadowner = await call("/api/admin/templates", "POST", { ownerId: 999999, name: "x" }, A);
  ok("admin cannot add a template for a missing client (400)", awbadowner.status === 400, awbadowner.data);
  const awlistMine = await call("/api/templates/custom", "GET", null, T1);
  ok("the admin-made template shows in the client's own list", awlistMine.data.length === 1 && awlistMine.data[0].name === "owner_made", awlistMine.data);
  const awlistAll = await call("/api/admin/templates", "GET", null, A);
  ok("admin lists every client's templates with the owner's name", awlistAll.data.length === 1 && awlistAll.data[0].email === C1.email, awlistAll.data);
  const awdel = await call("/api/admin/templates/" + awadd.data.id, "DELETE", null, A);
  ok("admin deletes a client's template", awdel.status === 200 && awdel.data.ok === true, awdel.data);

  const phoneDenied = await call("/api/admin/clients/" + C1.id, "PATCH", { phone: "+911234567890" }, T1);
  ok("a client cannot set a sender number through the admin route (403)", phoneDenied.status === 403, phoneDenied);
  const phoneBad = await call("/api/admin/clients/" + C1.id, "PATCH", { phone: "12" }, A);
  ok("admin setting an invalid sender number is rejected (400)", phoneBad.status === 400, phoneBad.data);
  const phoneSet = await call("/api/admin/clients/" + C1.id, "PATCH", { phone: "+91 90000 22222" }, A);
  ok("admin sets a client's sender number, normalised", phoneSet.status === 200 && phoneSet.data.phone === "+919000022222", phoneSet.data);
  const phoneMissing = await call("/api/admin/clients/999999", "PATCH", { phone: "+919000022222" }, A);
  ok("editing a missing client is a 404", phoneMissing.status === 404, phoneMissing.data);

  const walDenied = await call("/api/admin/clients/" + C1.id + "/wallet", "GET", null, T1);
  ok("a client cannot read the admin wallet view (403)", walDenied.status === 403, walDenied);
  const wal = await call("/api/admin/clients/" + C1.id + "/wallet", "GET", null, A);
  ok("admin wallet returns balance, ledger, payments and templates", wal.status === 200 && wal.data.client.id === C1.id
    && Array.isArray(wal.data.txns) && Array.isArray(wal.data.requests) && Array.isArray(wal.data.templates)
    && typeof wal.data.summary.credits === "number", wal.data && Object.keys(wal.data));
  ok("admin wallet ledger records grants and campaign spends", wal.data.txns.length >= 2
    && wal.data.txns.some((t) => t.type === "spend"), wal.data.txns.length);
  const wadd = await call("/api/admin/templates", "POST", { ownerId: C1.id, name: "wallet_tpl", category: "MARKETING" }, A);
  const wal2 = await call("/api/admin/clients/" + C1.id + "/wallet", "GET", null, A);
  ok("admin wallet surfaces the client's templates", wal2.data.templates.some((t) => t.id === wadd.data.id && t.name === "wallet_tpl"), wal2.data.templates);
  await call("/api/admin/templates/" + wadd.data.id, "DELETE", null, A);
  const walMissing = await call("/api/admin/clients/999999/wallet", "GET", null, A);
  ok("wallet for a missing client is a 404", walMissing.status === 404, walMissing.data);

  // ---------- helo health check (admin only, and it must never send) ----------
  const heloClient = await call("/api/helo/status", "GET", null, T1);
  ok("client cannot read the helo health check (403)", heloClient.status === 403, heloClient);
  const heloAdmin = await call("/api/helo/status", "GET", null, A);
  ok("admin health check runs without credentials and explains why", heloAdmin.status === 200
    && heloAdmin.data.ok === false && /HELO_BASE_URL/.test(heloAdmin.data.reason), heloAdmin.data);
  const cfg = await call("/api/config", "GET", null, A);
  ok("config reports Helo as not connected while unconfigured", cfg.status === 200
    && cfg.data.heloConnected === false, cfg.data);
  const heloAnon = await call("/api/helo/status", "GET");
  ok("health check needs a token (401)", heloAnon.status === 401, heloAnon);

  // ---------- the old product/order surface is gone ----------
  const oldProducts = await call("/api/products", "GET", null, T1);
  ok("the product catalogue is gone (404)", oldProducts.status === 404, oldProducts);
  const oldOrders = await call("/api/orders", "GET", null, T1);
  ok("the order history is gone (404)", oldOrders.status === 404, oldOrders);

  console.log("\n" + pass + " passed, " + fail + " failed");
  // the exit handler tears down the server and restores data/db.json
  process.exit(fail ? 1 : 0);
})();
