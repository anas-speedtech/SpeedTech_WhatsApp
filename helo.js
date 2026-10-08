// Helo / VivaConnect WhatsApp API client.
// Docs: https://docs.helo.ai/helo-whatsapp (Helo-WhatsApp project, v1).
//
// Endpoints actually used, with the shape each one expects:
//   POST /user/authenticate              { userId, apiKey }   -> data.token (a JWT)
//   POST /user/sign-in-user              { userName, password } -> data.token (a JWT)
//   GET  /business/getAllWabas           -> data.wabaDetails[].whatsappBusinessId
//   GET  /templates/list/{wabaId}        -> data.details[].templateBody{name,category,language}
//   POST /messages/single                { ...one message }
// Auth is `Authorization: Bearer <jwt>` on every call except the sign-in itself.
//
// Accounts are authenticated either with an API key or with userName+password, and the
// password path is not published in the docs, so both the path and the field names are
// configurable via HELO_SIGNIN_PATH / HELO_SIGNIN_USER_FIELD / HELO_SIGNIN_PASS_FIELD.
//
// With no credentials configured every function short-circuits and the panel keeps
// running in simulation mode, so this file must never throw at require time.

const BASE = (process.env.HELO_BASE_URL || "").replace(/\/+$/, "");
const USER_ID = process.env.HELO_USER_ID || "";
const API_KEY = process.env.HELO_API_KEY || "";
const PASSWORD = process.env.HELO_PASSWORD || "";
const FROM = process.env.HELO_FROM || "";
const CONFIGURED_WABA = process.env.HELO_WABA_ID || "";
// how many single-send requests may be in flight at once. Not a batch size: Helo's
// single-send endpoint takes one recipient per call, so campaigns fan out N calls.
const CONCURRENCY = Math.max(1, Math.min(20, Number(process.env.HELO_BATCH_SIZE) || 5));
const CHECK_CONSENT = process.env.HELO_CHECK_CONSENT !== "false";

// Helo documents two ways to authenticate. This account has no API key, so it needs the
// userName+password path, whose exact route and field names are not in the public docs.
// Configurable so a corrected value needs no code change.
const USE_PASSWORD = !API_KEY && Boolean(PASSWORD);
const SIGNIN_PATH = process.env.HELO_SIGNIN_PATH || "/user/sign-in-user";
const SIGNIN_USER_FIELD = process.env.HELO_SIGNIN_USER_FIELD || "userName";
const SIGNIN_PASS_FIELD = process.env.HELO_SIGNIN_PASS_FIELD || "password";

let token = null;
let tokenExpiry = 0; // ms epoch
let signingIn = null; // shared promise, so a burst of campaigns only signs in once
let wabaCache = "";

// enough credentials to talk to the API at all
const hasCredentials = () => Boolean(BASE && USER_ID && (API_KEY || PASSWORD));
// enough to actually put a message on the wire (the sender number is mandatory)
const configured = () => hasCredentials() && Boolean(FROM);

// Helo wants bare digits with the country code and no "+", but we store phones
// normalised as +919876543210 for display.
const digits = (p) => String(p == null ? "" : p).replace(/\D/g, "");

async function call(method, path, body, auth = true) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    // Node's fetch buries the underlying error under e.cause. Pull it out so the panel
    // shows whether the host didn't resolve (ENOTFOUND) or just didn't answer (timeout).
    const causes = [];
    let c = e;
    for (let i = 0; i < 4 && c; i++) {
      const m = c.code || c.message;
      if (m && !causes.includes(m)) causes.push(m);
      c = c.cause;
    }
    const detail = causes.join(" <- ") || String(e && e.message || e);
    const bad = /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|EAI_AGAIN|TLS|certificate|getaddrinfo|timeout/i.test(detail);
    throw new Error(`Helo unreachable (${BASE}${path}): ${bad ? "network error: " : ""}${detail.slice(0, 200)}`);
  }
  // Read the body as text first. When Helo's own app crashes it replies with an HTML
  // stack trace, and json() would swallow it, leaving a useless "Helo 500: {}".
  const raw = await res.text();
  const ctype = res.headers.get("content-type") || "";
  let data = {};
  try { data = ctype.includes("json") || /^[[{"]/.test(raw.trim()) ? JSON.parse(raw) : {}; } catch { data = {}; }

  if (!res.ok) {
    const detail = (data && (data.message || data.error)) ||
      (/^\s*</.test(raw) ? raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "") ||
      raw.trim() || JSON.stringify(data) || "(empty body)";
    const err = new Error(`Helo ${res.status}: ${String(detail).slice(0, 300)}`);
    err.status = res.status;
    err.heloHtml = /^\s*</.test(raw);
    throw err;
  }
  // Helo reports many failures with HTTP 200 and the real error buried in the body,
  // e.g. { statusCode: 200, data: { status: "false", code: 3501, message: "..." } }.
  // Treating those as success would silently mark rejected recipients as accepted.
  const inner = data && data.data;
  if (inner && (inner.status === false || inner.status === "false")) {
    const err = new Error(`Helo rejected the request (${inner.code || "no code"}): ${String(inner.message || JSON.stringify(inner)).slice(0, 300)}`);
    err.heloCode = inner.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

async function signIn(force = false) {
  if (!force && token && Date.now() < tokenExpiry) return token;
  if (signingIn) return signingIn;
  const path = USE_PASSWORD ? SIGNIN_PATH : "/user/authenticate";
  const body = USE_PASSWORD
    ? { [SIGNIN_USER_FIELD]: USER_ID, [SIGNIN_PASS_FIELD]: PASSWORD }
    : { userId: USER_ID, apiKey: API_KEY };
  signingIn = call("POST", path, body, false)
    .then((json) => {
      const t = json && json.data && json.data.token;
      if (!t) throw new Error("Helo did not return a token: " + JSON.stringify(json).slice(0, 200));
      token = t;
      // expiresIn is an ms epoch string in their docs; if it is not a plausible
      // epoch, fall back to a conservative 30 minutes rather than trusting it.
      const exp = Number(json.data.expiresIn);
      tokenExpiry = Number.isFinite(exp) && exp > 1e12 ? exp - 60000 : Date.now() + 30 * 60000;
      signingIn = null;
      return t;
    })
    .catch((e) => { signingIn = null; throw e; });
  return signingIn;
}

// every authenticated call goes through here so one stale token can't wedge the panel
async function authed(method, path, body) {
  await signIn();
  try {
    return await call(method, path, body, true);
  } catch (e) {
    if (e.status !== 401) throw e;
    token = null;
    await signIn(true);
    return call(method, path, body, true);
  }
}

async function listWabas() {
  const json = await authed("GET", "/business/getAllWabas");
  const details = json && json.data && json.data.wabaDetails;
  if (!Array.isArray(details)) throw new Error("Unexpected getAllWabas shape: " + JSON.stringify(json).slice(0, 200));
  return details;
}

async function wabaId() {
  if (CONFIGURED_WABA) return CONFIGURED_WABA;
  if (wabaCache) return wabaCache;
  const wabas = await listWabas();
  const active = wabas.find((w) => w.isActive) || wabas[0];
  if (!active || !active.whatsappBusinessId) throw new Error("No WhatsApp Business account found on this Helo account");
  wabaCache = active.whatsappBusinessId;
  return wabaCache;
}

// -> [{ name, category, language, status }]
async function listTemplates() {
  if (!hasCredentials()) return [{ name: "demo_template", status: "SIMULATED" }];
  const id = await wabaId();
  const json = await authed("GET", `/templates/list/${encodeURIComponent(id)}?limit=999&page=1`);
  const details = json && json.data && json.data.details;
  if (!Array.isArray(details)) throw new Error("Unexpected template list shape: " + JSON.stringify(json).slice(0, 200));
  return details
    .map((d) => {
      const b = (d && d.templateBody) || {};
      const lang = (b.language && (b.language.code || b.language)) || "";
      return { name: b.name || "", category: b.category || "", language: String(lang), status: d.lastStatus || "" };
    })
    .filter((t) => t.name);
}

// Helo's template list can return a display name ("English") where the send API wants a
// code ("en"). Passing the display name through verbatim is rejected with code 3501.
const LANGUAGE_CODES = {
  english: "en", "en us": "en_US", "en gb": "en_GB", hindi: "hi", marathi: "mr",
  gujarati: "gu", bengali: "bn", tamil: "ta", telugu: "te", kannada: "kn", malayalam: "ml",
  punjabi: "pa", urdu: "ur", arabic: "ar", french: "fr", german: "de", spanish: "es",
  portuguese: "pt_BR", dutch: "nl", russian: "ru", chinese: "zh_CN", thai: "th",
  indonesian: "id", turkish: "tr", vietnamese: "vi", swahili: "sw", zulu: "zu",
};
const normaliseLanguage = (v) => {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "en";
  return LANGUAGE_CODES[s.toLowerCase()] || s;
};

// One call per recipient. Helo's single-send endpoint takes a single message, so a
// campaign of N recipients is N requests, run with bounded concurrency.
async function sendToOne({ from, to, category, language, templateName, vars, consent }) {
  const template = { name: templateName, category, language: { code: normaliseLanguage(language) } };
  if (vars.length) {
    template.components = [{ type: "body", parameters: vars.map((v) => ({ type: "text", text: String(v) })) }];
  }
  const json = await authed("POST", "/messages/single", {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    from,
    check_consent: consent,
    template,
  });
  const resp = (json && json.data && json.data.response) || {};
  return { messageId: resp.messageId || null };
}

// recipients: phone strings. params: { "<digits>": ["var1", "var2"] } for body variables.
// onAccepted(phone, messageId) fires as each recipient is accepted, so the caller can
// bill incrementally instead of waiting for the whole campaign.
// Resolves to per-recipient results so partial rejections are visible and billable-correct.
async function sendBulkTemplate({
  templateName, templateCategory, templateLanguage, recipients, params, checkConsent, onAccepted,
}) {
  if (!configured()) return { simulated: true, accepted: recipients.length, results: [] };

  const from = digits(FROM);
  if (!from) throw new Error("HELO_FROM is not set, so there is no sender number");
  const category = String(templateCategory || "MARKETING");
  const consent = checkConsent === undefined ? CHECK_CONSENT : Boolean(checkConsent);
  const byPhone = params && typeof params === "object" ? params : {};

  const jobs = recipients.map((phone) => {
    const to = digits(phone);
    const vars = Array.isArray(byPhone[to]) ? byPhone[to] : Array.isArray(byPhone[phone]) ? byPhone[phone] : [];
    return { phone, to, vars };
  });

  const results = new Array(jobs.length);
  let next = 0;
  // Each worker pulls the next job, so a slow recipient cannot stall the others.
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= jobs.length) return;
      const { phone, to, vars } = jobs[i];
      try {
        const { messageId } = await sendToOne({ from, to, category, language: templateLanguage,
          templateName, vars, consent });
        results[i] = { phone: to, accepted: true, messageId: messageId || null, error: null };
        if (onAccepted) await onAccepted(to, messageId);
      } catch (e) {
        // A per-recipient failure is a result, not a crash: one bad number must not
        // abandon the rest of the campaign.
        results[i] = { phone: to, accepted: false, messageId: null, error: e.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));

  const accepted = results.filter((r) => r && r.accepted).length;
  return { simulated: false, accepted, results };
}

// login -> WABA -> approved templates, without sending anything
async function health() {
  if (!hasCredentials()) {
    return { ok: false, reason: "HELO_BASE_URL, HELO_USER_ID and either HELO_API_KEY or HELO_PASSWORD must all be set", from: digits(FROM) || null };
  }
  const wabas = await listWabas();
  const id = await wabaId();
  const templates = await listTemplates();
  return {
    ok: true,
    baseUrl: BASE,
    from: digits(FROM) || null,
    wabaId: id,
    wabas: wabas.map((w) => ({ whatsappBusinessId: w.whatsappBusinessId, name: w.name, isActive: w.isActive })),
    templateCount: templates.length,
    approved: templates.filter((t) => t.status === "APPROVED").length,
  };
}

function forget() { token = null; tokenExpiry = 0; wabaCache = ""; signingIn = null; }

module.exports = {
  configured, hasCredentials, signIn, listWabas, wabaId, listTemplates, sendBulkTemplate, health, forget,
  from: () => digits(FROM), digits, normaliseLanguage, baseUrl: () => BASE,
  concurrency: () => CONCURRENCY, signinPath: () => (USE_PASSWORD ? SIGNIN_PATH : "/user/authenticate"),
  authMode: () => (USE_PASSWORD ? "password" : "apiKey"),
};
