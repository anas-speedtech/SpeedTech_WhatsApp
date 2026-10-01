// Exercises the background send queue in server.js against a FAKE Helo server.
// The other suites run with no HELO_BASE_URL, so campaigns take the simulated path
// and this code never runs. This one starts a local stub Helo plus the real server
// with credentials set, and checks credits, status and polling behave.
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const PROJ = path.join(__dirname, "..");
const PORT = 3111, HELO_PORT = 3112;
// Test credentials are generated per run rather than hardcoded, so nothing sensitive is
// ever committed and the suite can never touch a real account.
const ADMIN_EMAIL = "test-admin@example.test";
const ADMIN_PASSWORD = "test-admin-pw-" + require("crypto").randomBytes(8).toString("hex");

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : " -> " + JSON.stringify(e))); };

// Every account this suite creates gets a unique suffix, so the suite can be run
// repeatedly against the same data/db.json without colliding on "email already registered".
const RUN = Date.now().toString(36) + require("crypto").randomBytes(3).toString("hex");
const qEmail = (name) => `${name}-${RUN}@qt.test`;

// the fake Helo: some numbers accepted, some rejected via the HTTP-200 + status:false trap
let slow = false;
let rejectAllNums = false;
// the stub rejects any number whose digits end in 3 or 5, mirroring the documented
// HTTP-200-with-status:false failure shape
const rejected = (to) => /[35]$/.test(to);
let sendCount = 0, concurrentNow = 0, peakConcurrent = 0;
const heloStub = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const p = req.url.split("?")[0];
  const j = (code, o) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (p === "/user/authenticate" || p === "/user/sign-in-user") {
    return j(200, { data: { token: "STUB-JWT", expiresIn: String(Date.now() + 3600e3) } });
  }
  if (p === "/business/getAllWabas") {
    return j(200, { data: { wabaDetails: [{ whatsappBusinessId: "222", isActive: true, name: "Stub" }] } });
  }
  if (p.startsWith("/templates/list/")) {
    return j(200, { data: { details: [{ templateBody: { name: "ismotors_client", category: "MARKETING", language: { code: "en" } }, lastStatus: "APPROVED" }] } });
  }
  if (p === "/messages/single") {
    sendCount++; concurrentNow++; peakConcurrent = Math.max(peakConcurrent, concurrentNow);
    if (slow) await new Promise((r) => setTimeout(r, 120));
    concurrentNow--;
    const m = JSON.parse(body || "{}");
    if (rejectAllNums || rejected(m.to)) {
      // the documented failure shape: HTTP 200 with the error buried in data
      return j(200, { statusCode: 200, message: "Success",
        data: { status: "false", code: 3501, requestId: "r", message: '"template.language.code" must be one of [en, hi]' } });
    }
    return j(200, { data: { status: true, requestId: "r", response: { messageId: "mid-" + m.to, to: m.to, from: m.from } } });
  }
  j(404, { message: "no stub" });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const req = async (method, url, body, token) => {
  const r = await fetch(url, { method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
// poll a campaign until it leaves "Sending"
const settle = async (BASE, token, id, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    const r = await req("GET", `${BASE}/api/campaigns`, null, token);
    const c = r.json.find((x) => x.id === id);
    if (c && c.status !== "Sending") return c;
    await sleep(100);
  }
  return null;
};

// This suite creates users, so it needs a throwaway copy of the database rather than
// the real data/db.json.
const fs = require("fs");
const DB = path.join(PROJ, "data", "db.json");
const REAL_DB = DB + ".queue-test-backup";
try { fs.copyFileSync(DB, REAL_DB); } catch (e) { console.log("no db to back up: " + e.message); }

(async () => {
  await new Promise((r) => heloStub.listen(HELO_PORT, r));
  const srv = spawn(process.execPath, ["server.js"], { cwd: PROJ, env: { ...process.env,
    PORT: String(PORT), HELO_BASE_URL: `http://127.0.0.1:${HELO_PORT}`,
    HELO_USER_ID: "stub-user", HELO_PASSWORD: "stub-pass", HELO_API_KEY: "",
    // an obviously fake sender: the suite runs against a local stub, and a real number
    // has no business being committed
    HELO_FROM: "919999999999", HELO_BATCH_SIZE: "2", HELO_CHECK_CONSENT: "true",
    JWT_SECRET: "test-secret", BRAND_NAME: "SpeedTech.ai", RESELLER_SIGNUP_CODE: "code123",
    ADMIN_EMAIL, ADMIN_PASSWORD } });
  let err = "", out = "";
  srv.stderr.on("data", (d) => { err += d; });
  srv.stdout.on("data", (d) => { out += d; });
  await sleep(2500);
  const BASE = `http://127.0.0.1:${PORT}`;

  try {
    if (out.trim() || err.trim()) console.log("server stdout: " + out.trim() + " | stderr: " + err.trim());
    // the child may still be binding, so give it a few attempts before failing
    let up = false, lastErr = "";
    for (let i = 0; i < 20 && !up; i++) {
      try { await req("GET", `${BASE}/api/config`); up = true; }
      catch (e) { lastErr = e.message; await sleep(500); }
    }
    if (!up) throw new Error("server never came up on " + PORT + ": " + lastErr + " | stdout=" + out.trim() + " stderr=" + err.trim());
    ok("server started", up, lastErr);
    const cfg = (await req("GET", `${BASE}/api/config`)).json;
    ok("config reports Helo connected once base+user+pass+from are set", cfg.heloConnected === true, cfg);

    const admin = (await req("POST", `${BASE}/api/auth/login`, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })).json;

    // a reseller with five buyers, two of whom Helo will reject
    const rsReg = await req("POST", `${BASE}/api/auth/register`, { name: "RS", email: qEmail("rs"),
      password: "pw12345678", role: "reseller", signupCode: "code123" });
    const rs = rsReg.json;
    ok("a reseller can register with the signup code", rsReg.status === 200 && rs.user && rs.user.resellerCode, rs);
    for (let i = 1; i <= 5; i++) {
      await req("POST", `${BASE}/api/auth/register`, { name: "B" + i, email: qEmail("b" + i),
        password: "pw12345678", role: "user", resellerCode: rs.user.resellerCode, phone: `+91987650000${i}` });
    }
    const withPhones = (await req("GET", `${BASE}/api/reseller/users`, null, rs.token)).json;
    ok("reseller sees the five buyers they created", withPhones.length === 5, withPhones.length);
    ok("every buyer has a normalised phone number", withPhones.every((b) => /^\+91\d{10}$/.test(b.phone)),
      withPhones.map((b) => b.phone));
    const noPhoneBuyer = { id: 999999, phone: "" }; // a buyer id that does not exist for this reseller

    // give the reseller credits
    const grant = await req("POST", `${BASE}/api/admin/resellers/${rs.user.id}/credits`, { amount: 100 }, admin.token);
    ok("admin can grant credits", grant.status === 200 && grant.json.credits === 100, grant);

    // ---------- health check, no sends ----------
    const h = await req("GET", `${BASE}/api/helo/status`, null, admin.token);
    ok("admin health check passes against the stub", h.json.ok === true, h.json);
    ok("health reports the approved template", h.json.approved === 1, h.json);
    ok("health sent no messages", sendCount === 0, sendCount);

    // ---------- the real send path ----------
    slow = true;
    const before = sendCount;
    const t0 = Date.now();
    const targetIds = withPhones.filter((b) => b.phone).map((b) => b.id);
    const post = await req("POST", `${BASE}/api/campaigns`, { name: "Launch",
      templateName: "ismotors_client", templateCategory: "MARKETING", templateLanguage: "English",
      customerIds: targetIds }, rs.token);
    const elapsed = Date.now() - t0;

    ok("campaign POST succeeds", post.status === 200, post);
    ok("campaign returns immediately as Sending, not after the whole send", post.json.campaign.status === "Sending", post.json.campaign && post.json.campaign.status);
    ok("the POST returns while sends are still in flight", elapsed < 400, elapsed);
    ok("no messages were sent synchronously", sendCount === before, sendCount - before);

    const done = await settle(BASE, rs.token, post.json.campaign.id);
    ok("the campaign leaves Sending on its own", done && done.status !== "Sending", done && done.status);

    const acceptedCount = sendCount - before;
    ok("one request per recipient, not one batch", acceptedCount === 5, acceptedCount);
    ok("concurrency is capped by HELO_BATCH_SIZE", peakConcurrent <= 2, peakConcurrent);
    ok("concurrency actually parallelises", peakConcurrent > 1, peakConcurrent);

    const expectTotal = withPhones.filter((b) => b.phone).length;
    const expectAccepted = withPhones.filter((b) => b.phone && !rejected(b.phone.replace(/\D/g, ""))).length;
    ok("only buyers with a phone were targeted", done.total === expectTotal, { total: done.total, expectTotal });
    ok("only Helo-accepted recipients are counted", done.accepted === expectAccepted, { accepted: done.accepted, expectAccepted });
    ok("rejected count matches", done.rejected === expectTotal - expectAccepted, { rejected: done.rejected });
    ok("status is Partial when some are rejected", done.status === "Partial", done.status);
    ok("failures are recorded with Helo's own message", (done.failures || []).length > 0
      && /3501/.test(done.failures[0].error), done.failures && done.failures[0]);

    // credits: charged only for what Helo accepted
    const after = (await req("GET", `${BASE}/api/me`, null, rs.token)).json;
    ok("credits are refunded for rejected recipients", after.credits === 100 - expectAccepted,
      { credits: after.credits, expected: 100 - expectAccepted });

    // ---------- a second campaign must be able to start while the first is done ----------
    const second = await req("POST", `${BASE}/api/campaigns`, { name: "Second",
      templateName: "ismotors_client", templateCategory: "MARKETING", templateLanguage: "en",
      customerIds: [targetIds[0]] }, rs.token);
    ok("a later campaign is accepted", second.status === 200, second);
    const done2 = await settle(BASE, rs.token, second.json.campaign.id);
    ok("the second campaign also completes", done2 && done2.status !== "Sending", done2 && done2.status);

    // ---------- all rejected -> Failed, credits fully refunded ----------
    sendCount = 0; peakConcurrent = 0; rejectAllNums = true;
    const beforeBad = (await req("GET", `${BASE}/api/me`, null, rs.token)).json.credits;
    const bad = await req("POST", `${BASE}/api/campaigns`, { name: "AllBad",
      templateName: "ismotors_client", templateCategory: "MARKETING", templateLanguage: "en",
      customerIds: targetIds }, rs.token);
    const badDone = await settle(BASE, rs.token, bad.json.campaign.id);
    ok("a campaign where every send fails is Failed", badDone.status === "Failed", badDone.status);
    ok("a fully failed campaign accepts nothing", badDone.accepted === 0, badDone.accepted);
    const afterBad = (await req("GET", `${BASE}/api/me`, null, rs.token)).json;
    ok("a fully failed campaign costs no credits", afterBad.credits === beforeBad, { before: beforeBad, after: afterBad.credits });
    rejectAllNums = false;

    // ---------- a reseller cannot target someone else's buyer ----------
    const rs2 = (await req("POST", `${BASE}/api/auth/register`, { name: "RS2", email: qEmail("rs2"),
      password: "pw12345678", role: "reseller", signupCode: "code123" })).json;
    ok("a second reseller registers", rs2.user && rs2.token, rs2);
    await req("POST", `${BASE}/api/admin/resellers/${rs2.user.id}/credits`, { amount: 50 }, admin.token);
    const foreign = await req("POST", `${BASE}/api/campaigns`, { name: "Sneaky",
      templateName: "ismotors_client", customerIds: targetIds }, rs2.token);
    ok("a reseller cannot target another reseller's buyers", foreign.status === 400, foreign);

    // ---------- no targetable recipients is refused ----------
    const nophone = await req("POST", `${BASE}/api/campaigns`, { name: "NoPhone",
      templateName: "ismotors_client", customerIds: [noPhoneBuyer.id] }, rs2.token);
    ok("targeting nobody is refused with 400", nophone.status === 400, nophone);

    // ---------- a client-supplied phone cannot override server-side ownership ----------
    const spoofed = await req("POST", `${BASE}/api/campaigns`, { name: "Spoofed",
      templateName: "ismotors_client", customerIds: targetIds,
      recipients: ["+10000000000"] }, rs.token);
    ok("a client-supplied recipients list is ignored", spoofed.status === 200, spoofed);
    const spoofDone = await settle(BASE, rs.token, spoofed.json.campaign.id);
    ok("only the server-resolved buyers were messaged", spoofDone.total === targetIds.length, spoofDone.total);

    // ---------- secrets never reach the client ----------
    const me = JSON.stringify((await req("GET", `${BASE}/api/me`, null, rs.token)).json);
    const cfgTxt = JSON.stringify(cfg);
    const healthTxt = JSON.stringify(h.json);
    ok("no password in /api/me", !/stub-pass/.test(me), me.slice(0, 200));
    ok("no password in /api/config", !/stub-pass/.test(cfgTxt), cfgTxt);
    ok("no password in the health check", !/stub-pass/.test(healthTxt), healthTxt);
    ok("no Helo token is ever sent to the browser", !/STUB-JWT/.test(me + cfgTxt + healthTxt), "token leaked");
  } catch (e) {
    ok("test harness completed without throwing", false, e && e.message);
  } finally {
    srv.kill();
    heloStub.close();
    // Put the real database back. If there was none to begin with, the file this run
    // created must be removed instead - leaving it behind would leave a stray admin
    // account that makes the next suite's own admin silently fail to seed.
    try {
      if (fs.existsSync(REAL_DB)) { fs.copyFileSync(REAL_DB, DB); fs.unlinkSync(REAL_DB); console.log("db.json restored"); }
      else { fs.unlinkSync(DB); console.log("no db.json existed before this run, removed the one it created"); }
    } catch (e) { console.log("could not restore db.json: " + e.message); }
  }
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
