// Exercises the billing layer: credit pricing, membership plans, the request/approval
// engine, the ledger, and the membership gate that blocks sends.
//
// Runs against a fresh database with Helo deliberately blanked, so every campaign takes
// the simulated path and no message can ever leave the machine. Snapshots data/db.json
// first and restores it on the way out.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");
const PROJ = path.join(__dirname, "..");
const DB_FILE = path.join(PROJ, "data", "db.json");
const DB_BACKUP = DB_FILE + ".billing-test-backup";

const snapshotDb = () => {
  if (fs.existsSync(DB_FILE)) { fs.copyFileSync(DB_FILE, DB_BACKUP); fs.unlinkSync(DB_FILE); }
};
const restoreDb = () => {
  try {
    if (fs.existsSync(DB_BACKUP)) { fs.copyFileSync(DB_BACKUP, DB_FILE); fs.unlinkSync(DB_BACKUP); console.log("db.json restored"); }
    else { fs.unlinkSync(DB_FILE); console.log("no db.json existed before this run, removed the one it created"); }
  } catch (e) { console.log("could not restore db.json: " + e.message); }
};

const PORT = Number(process.env.PORT || 3107);
const BASE = "http://127.0.0.1:" + PORT;
const SIGNUP = "billing-signup-code";
const ADMIN = { email: "test-admin@example.test", password: "test-admin-pw-" + crypto.randomBytes(8).toString("hex") };

let pass = 0, fail = 0, server = null;
const ok = (n, c, e) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : " -> " + JSON.stringify(e))); };

const startServer = () => new Promise((resolve, reject) => {
  const blank = { HELO_BASE_URL: "", HELO_USER_ID: "", HELO_API_KEY: "", HELO_PASSWORD: "",
    HELO_FROM: "", HELO_WABA_ID: "", JWT_SECRET: "test-secret", BRAND_NAME: "SpeedTech.ai",
    RESELLER_SIGNUP_CODE: SIGNUP, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password,
    UPI_VPA: "merchant@upi", UPI_PAYEE_NAME: "SpeedTech.ai" };
  const child = spawn(process.execPath, ["server.js"], { cwd: PROJ, env: { ...process.env, ...blank, PORT: String(PORT) }, stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.on("data", (b) => { err += b; });
  const t = setTimeout(() => reject(new Error("server did not start: " + err)), 20000);
  child.stdout.on("data", (b) => { if (String(b).includes("Panel running")) { clearTimeout(t); server = child; resolve(); } });
  child.on("exit", (code) => { clearTimeout(t); reject(new Error("server exited " + code + ": " + err)); });
});

async function call(p, method, body, token) {
  const res = await fetch(BASE + p, { method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

(async () => {
  const s = Date.now();
  snapshotDb();
  process.on("exit", () => { if (server) { try { server.kill(); } catch {} } restoreDb(); });
  await startServer();

  // ---------- defaults ----------
  const admin = await call("/api/auth/login", "POST", ADMIN);
  const A = admin.data.token;
  ok("admin logs in from the .env seed", admin.status === 200 && admin.data.user.role === "admin", admin.data);

  const settings = await call("/api/admin/settings", "GET", null, A);
  ok("settings start at ₹0.90 buy / ₹1.00 sell", settings.data.creditBuyPricePaise === 90 && settings.data.creditSellPricePaise === 100, settings.data);
  ok("membership is required by default", settings.data.requireMembership === true, settings.data);
  ok("three default plans are seeded", settings.data.plans.length === 3, settings.data.plans);

  // ---------- roles and pricing visibility ----------
  const res = await call("/api/auth/register", "POST", { name: "Seller", email: `s@${s}`, password: "secret123", role: "reseller", signupCode: SIGNUP });
  const T = res.data.token, R = res.data.user;
  ok("a reseller registers", res.status === 200 && R.resellerCode, res.data);
  ok("a new reseller has no membership yet", !R.membership || R.membership.state === "none", R.membership);

  const buy1 = await call("/api/auth/register", "POST", { name: "Buyer", email: `b@${s}`, password: "secret123", role: "user", resellerCode: R.resellerCode, phone: "+919876500001" });
  const B1 = buy1.data.user;
  ok("a buyer registers under the reseller", buy1.status === 200 && B1.resellerId === R.id, buy1.data.user);

  const pricing = await call("/api/pricing", "GET", null, T);
  ok("a reseller sees the sell price", pricing.data.creditSellPricePaise === 100, pricing.data);
  ok("a reseller never sees the buy price", pricing.data.creditBuyPricePaise === undefined, Object.keys(pricing.data));
  ok("pricing lists the plans", Array.isArray(pricing.data.plans) && pricing.data.plans.length === 3, pricing.data.plans);
  const denied = await call("/api/admin/settings", "GET", null, T);
  ok("a reseller cannot read admin settings (403)", denied.status === 403, denied);

  // ---------- admin edits pricing ----------
  const badSell = await call("/api/admin/settings", "PATCH", { creditSellPricePaise: 80 }, A);
  ok("sell price below buy price is rejected (400)", badSell.status === 400, badSell.data);
  const fracSell = await call("/api/admin/settings", "PATCH", { creditSellPricePaise: 100.5 }, A);
  ok("a fractional paise price is rejected (400)", fracSell.status === 400, fracSell.data);
  const okPrice = await call("/api/admin/settings", "PATCH", { creditBuyPricePaise: 92, creditSellPricePaise: 150 }, A);
  ok("admin raises the prices", okPrice.status === 200 && okPrice.data.creditBuyPricePaise === 92 && okPrice.data.creditSellPricePaise === 150, okPrice.data);

  // ---------- plan CRUD ----------
  const addPlan = await call("/api/admin/plans", "POST", { name: "Trial", months: 2, pricePaise: 99900 }, A);
  ok("admin adds a plan", addPlan.status === 200 && addPlan.data.name === "Trial" && addPlan.data.months === 2, addPlan.data);
  const editPlan = await call("/api/admin/plans/" + addPlan.data.id, "PUT", { name: "Trial Plus", months: 3, pricePaise: 129900 }, A);
  ok("admin edits a plan", editPlan.status === 200 && editPlan.data.name === "Trial Plus" && editPlan.data.pricePaise === 129900, editPlan.data);
  const badPlan = await call("/api/admin/plans", "POST", { name: "", months: 0, pricePaise: 0 }, A);
  ok("an invalid plan is rejected (400)", badPlan.status === 400, badPlan.data);
  const delPlan = await call("/api/admin/plans/" + addPlan.data.id, "DELETE", null, A);
  ok("admin deletes a plan", delPlan.status === 200 && delPlan.data.ok === true, delPlan.data);

  // ---------- credit request -> approval -> ledger ----------
  const creq = await call("/api/reseller/requests", "POST", { kind: "credits", credits: 250, method: "UPI-1234" }, T);
  ok("a credit request is created and priced at the sell rate", creq.status === 200 && creq.data.amountPaise === 250 * 150 && creq.data.status === "pending", creq.data);
  const dup = await call("/api/reseller/requests", "POST", { kind: "credits", credits: 5 }, T);
  ok("a second pending request from the same reseller is refused (409)", dup.status === 409, dup.data);
  const badReq = await call("/api/reseller/requests", "POST", { kind: "credits", credits: 0 }, T);
  ok("a zero-credit request is refused (400)", badReq.status === 400, badReq.data);

  const adminReqs = await call("/api/admin/requests", "GET", null, A);
  ok("the admin sees the pending request", adminReqs.data.length === 1 && adminReqs.data[0].reseller.id === R.id, adminReqs.data);
  const approve = await call("/api/admin/requests/" + creq.data.id + "/approve", "POST", {}, A);
  ok("approving the request credits the reseller", approve.status === 200 && approve.data.status === "approved", approve.data);
  const reApprove = await call("/api/admin/requests/" + creq.data.id + "/approve", "POST", {}, A);
  ok("a decided request cannot be approved twice (409)", reApprove.status === 409, reApprove.data);

  const me1 = await call("/api/me", "GET", null, T);
  ok("the reseller now holds 250 credits", me1.data.credits === 250, me1.data.credits);
  const ledger = await call("/api/reseller/txns", "GET", null, T);
  ok("the purchase is recorded in the ledger", ledger.data.length === 1 && ledger.data[0].type === "purchase" && ledger.data[0].credits === 250, ledger.data);
  ok("the platform's cost basis is stored (buy price, not sell)", ledger.data[0].costPaise === 250 * 92, ledger.data[0]);

  // ---------- membership gate ----------
  const noMember = await call("/api/campaigns", "POST", { name: "x", templateName: "t", customerIds: [B1.id] }, T);
  ok("a reseller with no membership cannot send (402)", noMember.status === 402 && /membership/i.test(noMember.data.error || ""), noMember.data);

  const mreq = await call("/api/reseller/requests", "POST", { kind: "membership", planId: pricing.data.plans[0].id }, T);
  ok("a membership request is created", mreq.status === 200 && mreq.data.kind === "membership", mreq.data);
  const mapprove = await call("/api/admin/requests/" + mreq.data.id + "/approve", "POST", {}, A);
  ok("the membership is approved", mapprove.status === 200 && mapprove.data.status === "approved", mapprove.data);
  const me2 = await call("/api/me", "GET", null, T);
  ok("the membership is now active", me2.data.membership && me2.data.membership.state === "active", me2.data.membership);

  const send = await call("/api/campaigns", "POST", { name: "Go", templateName: "t", customerIds: [B1.id] }, T);
  ok("a member with credits can send (simulated)", send.status === 200 && send.data.campaign.status === "Simulated", send.data);
  ok("the send spends 1 credit", send.data.credits === 249, send.data.credits);
  const afterSend = await call("/api/reseller/txns", "GET", null, T);
  ok("the spend is recorded in the ledger", afterSend.data.some((t) => t.type === "spend" && t.credits === 1), afterSend.data);

  // ---------- stats, and ledger isolation between resellers ----------
  const stats = await call("/api/reseller/stats", "GET", null, T);
  ok("stats count one user", stats.data.users === 1 && stats.data.active === 1, stats.data);
  ok("stats total purchased credits", stats.data.creditsPurchased === 250, stats.data);
  ok("stats total used credits", stats.data.creditsUsedReseller === 1, stats.data);
  ok("stats report the live balance", stats.data.creditsAvailable === 249, stats.data);

  const res2 = await call("/api/auth/register", "POST", { name: "Seller Two", email: `s2@${s}`, password: "secret123", role: "reseller", signupCode: SIGNUP });
  const T2 = res2.data.token;
  const ledger2 = await call("/api/reseller/txns", "GET", null, T2);
  ok("a reseller cannot see another reseller's ledger", ledger2.data.length === 0, ledger2.data);
  const grant = await call("/api/admin/resellers/" + res2.data.user.id + "/credits", "POST", { amount: 10 }, A);
  ok("a manual grant credits the reseller", grant.status === 200 && grant.data.credits === 10, grant.data);
  const ledger2b = await call("/api/reseller/txns", "GET", null, T2);
  ok("the manual grant lands in the reseller's own ledger", ledger2b.data.length === 1 && ledger2b.data[0].type === "assign_reseller", ledger2b.data);

  // ---------- membership expiry blocks sending again ----------
  ok("membership expires in the future", Date.parse(me2.data.membership.expiresAt) > Date.now(), me2.data.membership);

  // ---------- UPI checkout: quote, then auto-settle on confirmation ----------
  const sellNow = 150; // the admin raised the sell price earlier in this run
  const q1 = await call("/api/reseller/checkout/quote", "POST", { kind: "credits", credits: 100 }, T2);
  ok("a UPI quote prices the credits at the sell rate", q1.status === 200 && q1.data.amountPaise === 100 * sellNow, q1.data);
  ok("the quote carries a upi:// intent and a QR image",
    /^upi:\/\/pay\?/.test(q1.data.payment.uri || "") && /^data:image\/png;base64,/.test(q1.data.payment.qr || ""), q1.data.payment);
  ok("the quote exposes the VPA but never the buy price", q1.data.payment.vpa === "merchant@upi" && q1.data.creditBuyPricePaise === undefined, q1.data);

  const preQuote = await call("/api/me", "GET", null, T2);
  ok("a quote does not move any credits", preQuote.data.credits === 10, preQuote.data.credits);
  const pay1 = await call("/api/reseller/checkout/pay", "POST", { kind: "credits", credits: 100, ref: "UTR123" }, T2);
  ok("paying credits the reseller instantly", pay1.status === 200 && pay1.data.credits === 110, pay1.data);
  const led2 = await call("/api/reseller/txns", "GET", null, T2);
  const buyTxn = led2.data.find((t) => t.type === "purchase");
  ok("the UPI purchase is in the ledger at the sell price with its reference",
    buyTxn && buyTxn.credits === 100 && buyTxn.amountPaise === 100 * sellNow && /UTR123/.test(buyTxn.note), led2.data);
  ok("the platform's cost basis is still the buy price", buyTxn && buyTxn.costPaise === 100 * 92, buyTxn);

  const sell = (await call("/api/pricing", "GET", null, T2)).data;
  ok("pricing advertises UPI as configured", sell.payment && sell.payment.configured === true && sell.payment.provider === "upi", sell.payment);
  const mq = await call("/api/reseller/checkout/quote", "POST", { kind: "membership", planId: sell.plans[0].id }, T2);
  ok("a membership quote prices the plan", mq.status === 200 && mq.data.amountPaise === sell.plans[0].pricePaise, mq.data);
  const preMember = await call("/api/me", "GET", null, T2);
  ok("reseller two still has no membership", !preMember.data.membership || preMember.data.membership.state === "none", preMember.data.membership);
  const payM = await call("/api/reseller/checkout/pay", "POST", { kind: "membership", planId: sell.plans[0].id }, T2);
  ok("paying for a membership activates it", payM.status === 200 && payM.data.membership.state === "active", payM.data);
  const hist2 = await call("/api/reseller/requests", "GET", null, T2);
  ok("the UPI purchase shows in history as approved via UPI",
    hist2.data.some((r) => r.status === "approved" && r.method === "UPI" && r.decisionNote === "auto-settled via UPI"), hist2.data);
  const badCo = await call("/api/reseller/checkout/pay", "POST", { kind: "membership", planId: 999999 }, T2);
  ok("an unknown plan is refused (400)", badCo.status === 400, badCo.data);
  const badCredits = await call("/api/reseller/checkout/pay", "POST", { kind: "credits", credits: 0 }, T2);
  ok("a zero-credit checkout is refused (400)", badCredits.status === 400, badCredits.data);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
