// Exercises helo.js against a stubbed Helo API. No real network, no real keys.
// Covers: password auth, single-send fan-out, 200-with-status:false rejection,
// language display-name normalisation, and progressive onAccepted callbacks.
const path = require("path");
const PROJ = path.join(__dirname, "..");
const HOST = "https://uat-wabaapp.helo.ai";
process.env.HELO_BASE_URL = HOST;
process.env.HELO_USER_ID = "test-user";
process.env.HELO_API_KEY = "test-key";
process.env.HELO_FROM = "+91 80808 12345";
process.env.HELO_BATCH_SIZE = "2";

let pass = 0, fail = 0;
const ok = (n, c, e) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : " -> " + JSON.stringify(e))); };

const fresh = () => {
  for (const k of Object.keys(require.cache)) if (k.includes("helo.js")) delete require.cache[k];
  return require(path.join(PROJ, "helo.js"));
};

let helo = fresh();
let calls = [];
let routes = {};
// A stub response carries either json or html; helo.js reads text() first and decides.
const stubRes = (status, one) => {
  const html = one.html;
  const text = html ? html : JSON.stringify(one.json === undefined ? {} : one.json);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => (h.toLowerCase() === "content-type" ? (html ? "text/html" : "application/json") : null) },
    text: async () => text,
    json: async () => one.json,
  };
};
global.fetch = async (url, opts = {}) => {
  const full = String(url).replace(HOST, "");
  const p = full.split("?")[0];
  const body = opts.body ? JSON.parse(opts.body) : undefined;
  calls.push({ p, full, method: opts.method, auth: (opts.headers || {}).Authorization, body });
  const r = routes[p];
  if (!r) return stubRes(404, { json: { message: "no stub for " + p } });
  // the route handler must be awaited, or slow responses cannot be observed
  const one = typeof r === "function" ? await r(body, calls) : r;
  return stubRes(one.status, one);
};
const reset = (r) => { calls = []; routes = r || {}; };
const authStub = { "/user/authenticate": { status: 200, json: { data: { token: "T", expiresIn: String(Date.now() + 3600e3) } } } };
const withAuth = (extra) => Object.assign({ "/user/authenticate": { status: 200, json: { data: { token: "T", expiresIn: String(Date.now() + 3600e3) } } } }, extra);
const accepted = (to) => ({ status: 200, json: { data: { status: true, requestId: "r", response: { messageId: "mid-" + to, to, from: "918080812345", messaging_product: "whatsapp" } } } });

(async () => {
  // ---------- configuration ----------
  ok("hasCredentials true with base+userId+apiKey", helo.hasCredentials());
  ok("configured true once HELO_FROM is set", helo.configured());
  ok("digits() strips + and spaces", helo.digits("+91 80808-12345") === "918080812345", helo.digits("+91 80808-12345"));
  ok("from() normalises the sender number", helo.from() === "918080812345", helo.from());
  ok("api-key account reports apiKey auth mode", helo.authMode() === "apiKey", helo.authMode());

  // ---------- sign in: API key ----------
  reset({ "/user/authenticate": { status: 200, json: { data: { token: "JWT-1", expiresIn: String(Date.now() + 3600e3) } } } });
  await helo.signIn(true);
  const auth = calls[0];
  ok("signs in at /user/authenticate", auth.p === "/user/authenticate" && auth.method === "POST", auth);
  ok("api-key sign-in body is {userId, apiKey}", auth.body.userId === "test-user" && auth.body.apiKey === "test-key", auth.body);
  ok("sign-in sends no Authorization header", auth.auth === undefined, auth.auth);

  // ---------- sign in: userName + password ----------
  delete process.env.HELO_API_KEY;
  process.env.HELO_PASSWORD = "hunter2";
  process.env.HELO_SIGNIN_PATH = "/user/sign-in-user";
  helo = fresh();
  ok("password account reports password auth mode", helo.authMode() === "password", helo.authMode());
  ok("password alone satisfies hasCredentials", helo.hasCredentials() === true);
  ok("configured() still needs HELO_FROM", helo.configured() === true);
  reset({ "/user/sign-in-user": { status: 200, json: { data: { token: "JWT-PW", expiresIn: String(Date.now() + 3600e3) } } } });
  const pwToken = await helo.signIn(true);
  const pw = calls[0];
  ok("password sign-in uses HELO_SIGNIN_PATH", pw.p === "/user/sign-in-user", pw.p);
  ok("password sign-in body is {userName, password}", pw.body.userName === "test-user" && pw.body.password === "hunter2", pw.body);
  ok("no apiKey is sent when authenticating by password", pw.body.apiKey === undefined, pw.body);
  ok("password sign-in returns a token", pwToken === "JWT-PW", pwToken);
  ok("signinPath() reports the configured path", helo.signinPath() === "/user/sign-in-user", helo.signinPath());

  // custom field names, in case Helo names the fields differently
  process.env.HELO_SIGNIN_USER_FIELD = "userId";
  process.env.HELO_SIGNIN_PASS_FIELD = "password";
  helo = fresh();
  reset({ "/user/sign-in-user": { status: 200, json: { data: { token: "JWT-PW2", expiresIn: String(Date.now() + 3600e3) } } } });
  await helo.signIn(true);
  ok("sign-in field names are configurable", calls[0].body.userId === "test-user" && calls[0].body.password === "hunter2"
    && calls[0].body.userName === undefined, calls[0].body);

  // a 404 on the guessed sign-in path must be reported, not silently swallowed
  helo = fresh();
  reset({});
  let signInErr = null;
  try { await helo.signIn(true); } catch (e) { signInErr = e; }
  ok("a wrong sign-in path surfaces the HTTP error", signInErr && /Helo 404/.test(signInErr.message), signInErr && signInErr.message);

  // back to API-key mode for the rest
  delete process.env.HELO_PASSWORD;
  process.env.HELO_API_KEY = "test-key";
  helo = fresh();

  // token extraction + cache + expiry
  helo = fresh(); reset({ "/user/authenticate": { status: 200, json: { data: { token: "JWT-NESTED", expiresIn: "4102444800000" } } } });
  const t = await helo.signIn(true);
  ok("token is read from data.token (nested), not top level", t === "JWT-NESTED", t);

  helo = fresh();
  reset({ "/user/authenticate": { status: 200, json: { data: { token: "T", expiresIn: String(Date.now() - 1000) } } } });
  await helo.signIn(true);
  const before = calls.filter((c) => c.p === "/user/authenticate").length;
  await helo.signIn();
  ok("an already-expired token triggers re-auth", calls.filter((c) => c.p === "/user/authenticate").length === before + 1, calls.length);

  helo = fresh(); reset(authStub);
  await helo.signIn(true); await helo.signIn(); await helo.signIn();
  ok("a valid token is reused, not re-fetched", calls.filter((c) => c.p === "/user/authenticate").length === 1, calls.length);

  helo = fresh(); reset({ "/user/authenticate": { status: 200, json: { data: {} } } });
  let threw = null;
  try { await helo.signIn(true); } catch (e) { threw = e; }
  ok("a token-less auth response throws instead of returning undefined", threw && /did not return a token/.test(threw.message), threw && threw.message);

  // ---------- WABA discovery ----------
  helo = fresh();
  reset(withAuth({ "/business/getAllWabas": { status: 200, json: { data: { wabaDetails: [
    { whatsappBusinessId: "111", isActive: false, name: "Old" },
    { whatsappBusinessId: "222", isActive: true, name: "Helo.ai" }] } } } }));
  ok("picks the first active WABA", (await helo.wabaId()) === "222", await helo.wabaId());
  await helo.wabaId();
  ok("WABA id is cached after first lookup", calls.filter((c) => c.p === "/business/getAllWabas").length === 1, calls.length);

  helo = fresh(); delete process.env.HELO_WABA_ID;
  reset(withAuth({ "/business/getAllWabas": { status: 200, json: { data: { wabaDetails: [] } } } }));
  let wabaErr = null;
  try { await helo.wabaId(); } catch (e) { wabaErr = e; }
  ok("an account with no WABA reports it clearly", wabaErr && /No WhatsApp Business account/.test(wabaErr.message), wabaErr && wabaErr.message);
  process.env.HELO_WABA_ID = "";

  // ---------- template list ----------
  helo = fresh();
  reset(withAuth({
    "/business/getAllWabas": { status: 200, json: { data: { wabaDetails: [{ whatsappBusinessId: "222", isActive: true, name: "Helo.ai" }] } } },
    "/templates/list/222": { status: 200, json: { data: { details: [
      { _id: "1", templateBody: { name: "promo", category: "MARKETING", language: { code: "en" } }, lastStatus: "APPROVED" },
      { _id: "2", templateBody: { name: "old", category: "UTILITY", language: { code: "hi" } }, lastStatus: "REJECTED" },
      { _id: "3", templateBody: { name: "pending_one" }, lastStatus: "PENDING" }] } } },
  }));

  const ts = await helo.listTemplates();
  ok("templates are flattened to name/category/language/status", ts.length === 3
    && ts[0].name === "promo" && ts[0].category === "MARKETING" && ts[0].language === "en" && ts[0].status === "APPROVED", ts);
  ok("a template with no language still returns", ts[2].name === "pending_one" && ts[2].language === "", ts[2]);
  ok("template list hits /templates/list/{wabaId}", calls.some((c) => c.p === "/templates/list/222"), calls.map((c) => c.p));
  ok("authenticated calls carry the bearer token", calls.filter((c) => c.auth === "Bearer T").length >= 1, calls.map((c) => c.auth));

  helo = fresh();
  reset(withAuth({
    "/templates/list/222": { status: 200, json: { data: { oops: true } } },
    "/business/getAllWabas": { status: 200, json: { data: { wabaDetails: [{ whatsappBusinessId: "222", isActive: true }] } } },
  }));
  let shapeErr = null;
  try { await helo.listTemplates(); } catch (e) { shapeErr = e; }
  ok("an unexpected template shape throws instead of returning empty", shapeErr && /Unexpected template list shape/.test(shapeErr.message), shapeErr && shapeErr.message);

  // ---------- 401 recovery ----------
  helo = fresh();
  let n = 0;
  reset({
    "/user/authenticate": { status: 200, json: { data: { token: "T" + (n += 1), expiresIn: String(Date.now() + 3600e3) } } },
    "/business/getAllWabas": (b, cs) => {
      const seen = cs.filter((c) => c.p === "/business/getAllWabas").length;
      return seen === 1
        ? { status: 401, json: { message: "jwt expired" } }
        : { status: 200, json: { data: { wabaDetails: [{ whatsappBusinessId: "9", isActive: true }] } } };
    },
  });
  ok("a 401 triggers one re-auth then retries", (await helo.wabaId()) === "9", calls.map((c) => c.p + " " + (c.auth || "")));

  // ---------- single send: one call per recipient ----------
  const RECIPIENTS = ["+9198765000001", "+9198765000002", "+9198765000003", "+9198765000004", "+9198765000005"];
  helo = fresh();
  reset(withAuth({ "/messages/single": (body) => accepted(body.to) }));
  const r = await helo.sendBulkTemplate({ templateName: "promo", templateCategory: "MARKETING", templateLanguage: "en", recipients: RECIPIENTS });
  const sends = calls.filter((c) => c.p === "/messages/single");
  ok("5 recipients means 5 single-send requests", sends.length === 5, sends.length);
  ok("no request goes to the old bulk endpoint", calls.every((c) => c.p !== "/messages/bulk"), calls.map((c) => c.p));
  ok("each request body is one message object, not an array", !Array.isArray(sends[0].body) && sends[0].body.messaging_product === "whatsapp", sends[0].body);
  ok("every recipient is sent to exactly once",
    JSON.stringify(sends.map((s) => s.body.to).sort()) === JSON.stringify(RECIPIENTS.map((d) => d.replace(/\D/g, "")).sort()),
    sends.map((s) => s.body.to));
  ok("`to` is bare digits, no +", sends[0].body.to === "9198765000001", sends[0].body.to);
  ok("`from` is the HELO_FROM number", sends[0].body.from === "918080812345", sends[0].body.from);
  ok("type is template and consent is checked", sends[0].body.type === "template" && sends[0].body.check_consent === true, sends[0].body);
  ok("template carries name, category and language code",
    sends[0].body.template.name === "promo" && sends[0].body.template.category === "MARKETING"
    && sends[0].body.template.language.code === "en", sends[0].body.template);
  ok("no components when there are no variables", sends[0].body.template.components === undefined, sends[0].body.template);
  ok("all accepted when every send succeeds", r.accepted === 5 && r.results.every((x) => x.accepted), r.accepted);
  ok("accepted recipients carry their messageId", r.results[0].messageId === "mid-9198765000001", r.results[0]);

  // concurrency is respected
  helo = fresh();
  let live = 0, peak = 0;
  reset(withAuth({ "/messages/single": async (body) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r2) => setTimeout(r2, 5));
    live--;
    return accepted(body.to);
  } }));
  await helo.sendBulkTemplate({ templateName: "t", recipients: RECIPIENTS });
  ok("concurrency never exceeds HELO_BATCH_SIZE", peak <= 2, peak);
  ok("concurrency actually runs sends in parallel", peak > 1, peak);

  // per-recipient body variables
  helo = fresh();
  reset(withAuth({ "/messages/single": (body) => accepted(body.to) }));
  await helo.sendBulkTemplate({ templateName: "promo", templateCategory: "MARKETING", templateLanguage: "en",
    recipients: ["+9198765000001", "+9198765000002"],
    params: { "9198765000001": ["Alice", "SAVE10"], "9198765000002": ["Bob", "SAVE20"] } });
  const vsend = calls.filter((c) => c.p === "/messages/single" && c.body.to === "9198765000001")[0];
  ok("variables become body components with text parameters",
    vsend.body.template.components[0].type === "body"
    && JSON.stringify(vsend.body.template.components[0].parameters) === JSON.stringify([{ type: "text", text: "Alice" }, { type: "text", text: "SAVE10" }]),
    vsend.body.template.components);

  helo = fresh();
  reset(withAuth({ "/messages/single": (body) => accepted(body.to) }));
  await helo.sendBulkTemplate({ templateName: "t", recipients: ["+9198765000001"], params: { "+9198765000001": ["Hi"] } });
  ok("params keyed with a + still match the recipient",
    calls.filter((c) => c.p === "/messages/single")[0].body.template.components[0].parameters[0].text === "Hi");

  // ---------- the 200-with-status:false bug ----------
  helo = fresh();
  reset(withAuth({ "/messages/single": { status: 200, json: {
    statusCode: 200, message: "Success",
    data: { status: "false", code: 3501, requestId: "x", message: '"template.language.code" must be one of [af, en, ...]' } } } }));
  const bad = await helo.sendBulkTemplate({ templateName: "t", recipients: ["+9198765000001", "+9198765000002"] });
  ok("HTTP 200 with data.status=false counts as 0 accepted", bad.accepted === 0 && bad.results.every((x) => !x.accepted), bad.accepted);
  ok("the buried error code surfaces in the failure reason", /3501/.test(bad.results[0].error), bad.results[0].error);
  ok("the buried message is preserved", /language\.code/.test(bad.results[0].error), bad.results[0].error);
  ok("boolean false is also treated as a failure", (await (async () => {
    helo = fresh();
    reset(withAuth({ "/messages/single": { status: 200, json: { data: { status: false, code: 1, message: "nope" } } } }));
    const z = await helo.sendBulkTemplate({ templateName: "t", recipients: ["+9198765000001"] });
    return z.accepted === 0;
  })()));

  // a single bad recipient must not abandon the rest
  helo = fresh();
  reset(withAuth({ "/messages/single": (body) => {
    if (body.to === "9198765000003") return { status: 200, json: { data: { status: "false", code: 3501, message: "bad lang" } } };
    return accepted(body.to);
  } }));
  const mixed = await helo.sendBulkTemplate({ templateName: "t", recipients: RECIPIENTS });
  ok("one bad recipient does not stop the others", mixed.accepted === 4, mixed.accepted);
  ok("the bad recipient is reported, not lost", mixed.results.length === 5
    && mixed.results.filter((x) => !x.accepted).length === 1, mixed.results.length);

  // a 404 on one send is a per-recipient failure, not a campaign crash
  helo = fresh();
  reset(withAuth({ "/messages/single": (body) => {
    if (body.to === "9198765000001") return { status: 404, json: { message: "no such route" } };
    return accepted(body.to);
  } }));
  const routeErr = await helo.sendBulkTemplate({ templateName: "t", recipients: RECIPIENTS });
  ok("a 404 on one send is contained to that recipient", routeErr.accepted === 4
    && /404/.test(routeErr.results.find((x) => x.phone === "9198765000001").error), routeErr.results[0]);

  // ---------- onAccepted fires per accepted message ----------
  helo = fresh();
  reset(withAuth({ "/messages/single": (body) => {
    if (body.to === "9198765000002") return { status: 200, json: { data: { status: "false", code: 3501, message: "x" } } };
    return accepted(body.to);
  } }));
  // 3 recipients, one of which Helo rejects, so exactly 2 are billable
  const billed = [];
  const inc = await helo.sendBulkTemplate({ templateName: "t", recipients: ["+9198765000001", "9198765000002", "9198765000003"],
    onAccepted: (to, mid) => billed.push(to) });
  ok("onAccepted fires once per accepted recipient", billed.length === inc.accepted && billed.length === 2, billed);
  ok("onAccepted never fires for a rejected recipient", !billed.includes("9198765000002"), billed);

  // ---------- language normalisation ----------
  ok("display name 'English' becomes the code en", helo.normaliseLanguage("English") === "en", helo.normaliseLanguage("English"));
  ok("'Hindi' becomes hi", helo.normaliseLanguage("Hindi") === "hi", helo.normaliseLanguage("Hindi"));
  ok("'en_US' passes through untouched", helo.normaliseLanguage("en_US") === "en_US", helo.normaliseLanguage("en_US"));
  ok("an already-valid code is left alone", helo.normaliseLanguage("ta") === "ta", helo.normaliseLanguage("ta"));
  ok("an empty language falls back to en", helo.normaliseLanguage("") === "en" && helo.normaliseLanguage(null) === "en", helo.normaliseLanguage(null));

  // the display name must not reach the wire
  helo = fresh();
  reset(withAuth({ "/messages/single": (body) => accepted(body.to) }));
  await helo.sendBulkTemplate({ templateName: "promo", templateCategory: "MARKETING", templateLanguage: "English", recipients: ["+9198765000001"] });
  ok("a display-name language is normalised before sending",
    calls.filter((c) => c.p === "/messages/single")[0].body.template.language.code === "en",
    calls.filter((c) => c.p === "/messages/single")[0].body.template.language);

  // ---------- unreachable host + other errors ----------
  helo = fresh();
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error("ECONNREFUSED"); };
  let netErr = null;
  try { await helo.signIn(true); } catch (e) { netErr = e; }
  global.fetch = realFetch;
  ok("an unreachable host is reported as such", netErr && /Helo unreachable/.test(netErr.message), netErr && netErr.message);

  helo = fresh();
  reset(withAuth({ "/messages/single": { status: 400, json: { message: "Template not approved" } } }));
  const apiRes = await helo.sendBulkTemplate({ templateName: "t", recipients: ["+9198765000001"] });
  // per-recipient sends isolate the failure instead of throwing, so the campaign
  // reports 0 accepted and surfaces Helo's own message
  ok("a 400 on a single send reports 0 accepted rather than crashing", apiRes.accepted === 0, apiRes);
  ok("an API error keeps Helo's own message", /Helo 400/.test(apiRes.results[0].error)
    && /Template not approved/.test(apiRes.results[0].error), apiRes.results[0].error);

  // ---------- simulation path: no credentials at all ----------
  delete process.env.HELO_BASE_URL; delete process.env.HELO_USER_ID;
  delete process.env.HELO_API_KEY; delete process.env.HELO_FROM; delete process.env.HELO_PASSWORD;
  reset({});
  helo = fresh();
  ok("with no env, hasCredentials is false", helo.hasCredentials() === false);
  ok("with no env, configured is false", helo.configured() === false);
  const sim = await helo.sendBulkTemplate({ templateName: "demo", recipients: ["+9198765000001", "+9198765000002"] });
  ok("with no env, sending is simulated and accepted", sim.simulated === true && sim.accepted === 2, sim);
  ok("with no env, no HTTP request is made", calls.length === 0, calls.map((c) => c.p));
  const simT = await helo.listTemplates();
  ok("with no env, one demo template is offered", simT.length === 1 && simT[0].name === "demo_template", simT);
  const simH = await helo.health();
  ok("with no env, health explains what is missing", simH.ok === false && /HELO_BASE_URL/.test(simH.reason), simH);

  // password-only account is still fully configured
  process.env.HELO_BASE_URL = HOST; process.env.HELO_USER_ID = "u"; process.env.HELO_PASSWORD = "p";
  delete process.env.HELO_API_KEY;
  helo = fresh();
  ok("a password-only account counts as having credentials", helo.hasCredentials() === true);
  ok("but still needs a sender number to be sendable", helo.configured() === false);

  // ---------- health ----------
  process.env.HELO_API_KEY = "k"; process.env.HELO_FROM = "918080812345";
  delete process.env.HELO_PASSWORD;
  helo = fresh();
  reset(withAuth({
    "/business/getAllWabas": { status: 200, json: { data: { wabaDetails: [{ whatsappBusinessId: "222", isActive: true, name: "Helo.ai" }] } } },
    "/templates/list/222": { status: 200, json: { data: { details: [
      { templateBody: { name: "a" }, lastStatus: "APPROVED" },
      { templateBody: { name: "b" }, lastStatus: "APPROVED" },
      { templateBody: { name: "c" }, lastStatus: "PENDING" }] } } },
  }));
  const h = await helo.health();
  ok("health reports host, sender, waba and approved count", h.ok === true && h.baseUrl === HOST
    && h.from === "918080812345" && h.wabaId === "222" && h.approved === 2 && h.templateCount === 3, h);
  ok("health does not send anything", calls.filter((c) => c.p === "/messages/single").length === 0, calls.map((c) => c.p));
  ok("health never leaks a secret", !/hunter2|test-key/.test(JSON.stringify(h)), JSON.stringify(h));

  // ---------- a crashing Helo deployment must not read as an empty JSON body ----------
  // When Helo's own app dies it answers with an HTML stack trace. Reporting "Helo 500: {}"
  // hides the fault that has to be sent to them, so the trace must survive into the message.
  const crash = "<!DOCTYPE html><html><body><pre>Error TypeError: response.header is not a function\n    at file:///app/src/api/routes/index.js:122:70</pre></body></html>";
  reset({ "/user/authenticate": { status: 500, html: crash } });
  helo = fresh();
  let crashErr = null;
  try { await helo.health(); } catch (e) { crashErr = e; }
  ok("an HTML 500 from Helo is surfaced, not swallowed as {}", !!crashErr && /response\.header is not a function/.test(crashErr.message), crashErr && crashErr.message);
  ok("the crash keeps the HTTP status", !!crashErr && crashErr.status === 500, crashErr && crashErr.status);
  ok("an HTML error is flagged as a non-JSON fault", !!crashErr && crashErr.heloHtml === true, crashErr && crashErr.heloHtml);
  ok("the crash message carries no secret", !!crashErr && !/hunter2|test-key/.test(crashErr.message), crashErr && crashErr.message);

  reset({ "/user/authenticate": { status: 502, json: { message: "bad gateway" } } });
  helo = fresh();
  let jsonErr = null;
  try { await helo.health(); } catch (e) { jsonErr = e; }
  ok("a JSON error body is still read as JSON", !!jsonErr && /bad gateway/.test(jsonErr.message), jsonErr && jsonErr.message);
  ok("a JSON error is not flagged as HTML", !!jsonErr && jsonErr.heloHtml === false, jsonErr && jsonErr.heloHtml);

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
