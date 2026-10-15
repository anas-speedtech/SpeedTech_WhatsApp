const fs = require("fs");
const vm = require("vm");

const el = (id) => ({
  id, innerHTML: "", textContent: "", value: "", dataset: {}, onclick: null, tagName: "DIV", style: {}, alt: "", files: [],
  classList: { _s: new Set(), add(...c) { c.forEach((x) => this._s.add(x)); },
    remove(...c) { c.forEach((x) => this._s.delete(x)); },
    toggle(c, f) { f ? this._s.add(c) : this._s.delete(c); }, contains(c) { return this._s.has(c); } },
  append() {}, appendChild() {}, remove() {}, focus() {}, click() {},
  setAttribute() {}, getAttribute: () => null, removeAttribute() {},
  querySelector: () => null, querySelectorAll: () => [],
});

const dom = new Map();
const get = (sel) => { if (!dom.has(sel)) dom.set(sel, el(sel)); return dom.get(sel); };

const AT = new Date("2026-09-20T10:00:00Z").toISOString();
const CLIENT = { id: 9, name: "Atulya", email: "a@x.com", role: "client", credits: 6, phone: "+919876543210",
  membership: { state: "active", planId: 1, expiresAt: AT, startedAt: AT }, active: true, onboardedAt: AT };
const ADMIN = { id: 2, name: "SpeedTech Admin", email: "admin@speedtech.ai", role: "admin", credits: 0, phone: "" };

const CONTACTS = [
  { id: 1, name: "Asha", phone: "+919876543210", at: AT },
  { id: 2, name: "", phone: "+919812345678", at: AT },
];
const CAMPAIGNS = [
  { id: 1, clientId: 9, name: "Diwali sale", templateName: "demo_template", total: 3, delivered: 3, failed: 0, status: "Simulated", at: AT },
  { id: 2, clientId: 9, name: "New year", templateName: "helo_shape", total: 1, delivered: 1, failed: 0, status: "Simulated", at: AT },
];

let ME = CLIENT;
const RESPONSES = {
  "/api/config": { brand: "TestBrand", heloConnected: false },
  "/api/me": () => ME,
  "/api/client/stats": { contacts: 2, campaigns: 2, recipients: 4, sent: 4, creditsPurchased: 10, creditsAssigned: 0, creditsUsed: 4, creditsAvailable: 6 },
  "/api/client/contacts": CONTACTS,
  "/api/campaigns": CAMPAIGNS,
  "/api/templates": [{ name: "demo_template", status: "SIMULATED" }, { templateName: "helo_shape", status_name: "APPROVED" }, { id: "raw_id" }],
  "/api/templates/custom": [{ id: 7, name: "my_hand_template", category: "MARKETING", language: "en", custom: true, status: "MANUAL", at: AT }],
  "/api/pricing": { creditSellPricePaise: 100, plans: [{ id: 1, name: "Starter", months: 1, pricePaise: 149900 }] },
  "/api/client/requests": [
    { id: 5, at: AT, kind: "credits", credits: 100, amountPaise: 10000, status: "pending" },
  ],
  "/api/client/txns": [
    { id: 1, at: AT, type: "purchase", fromId: null, toId: 9, credits: 10, amountPaise: 1000, note: "approved" },
  ],
  "/api/admin/clients": [
    { id: 1, name: "Atulya", email: "a@x.com", role: "client", phone: "+919876543210", credits: 6, contacts: 2, campaigns: 2, templates: 1,
      creditsPurchased: 5, creditsAssigned: 1, creditsUsed: 4, revenuePaise: 2000, membership: { state: "active", expiresAt: AT }, active: true },
    { id: 3, name: "Rival", email: "r@x.com", role: "client", phone: "", credits: 0, contacts: 0, campaigns: 0, templates: 0,
      creditsPurchased: 0, creditsAssigned: 0, creditsUsed: 0, revenuePaise: 0, membership: { state: "none" }, active: false },
  ],
  "/api/admin/templates": [
    { id: 7, name: "my_hand_template", category: "MARKETING", language: "en", custom: true, status: "MANUAL", at: AT, ownerId: 1, owner: "Atulya", email: "a@x.com" },
  ],
  "/api/admin/clients/1/wallet": {
    client: { id: 1, name: "Atulya", email: "a@x.com", role: "client", credits: 6, phone: "+919876543210" },
    summary: { id: 1, name: "Atulya", email: "a@x.com", credits: 6, creditsPurchased: 5, creditsAssigned: 1, creditsUsed: 4,
      contacts: 2, campaigns: 2, templates: 1, membership: { state: "active", expiresAt: AT }, active: true },
    txns: [{ id: 1, at: AT, type: "purchase", fromId: null, toId: 1, credits: 10, note: "approved" }],
    requests: [{ id: 5, at: AT, kind: "credits", credits: 100, amountPaise: 10000, status: "pending", method: "upi" }],
    templates: [{ id: 7, name: "my_hand_template", category: "MARKETING", language: "en", ownerId: 1 }],
  },
  "/api/admin/requests": [
    { id: 5, at: AT, kind: "credits", credits: 100, amountPaise: 10000, status: "pending",
      client: { id: 1, name: "Atulya", email: "a@x.com" }, plan: null },
  ],
  "/api/admin/settings": { creditBuyPricePaise: 90, creditSellPricePaise: 100, requireMembership: true,
    plans: [{ id: 1, name: "Starter", months: 1, pricePaise: 149900 }] },
  "/api/helo/status": { ok: true, baseUrl: "http://x", from: "919876543210", approved: 1, templateCount: 1,
    wabas: [{ whatsappBusinessId: "222", isActive: true, name: "Stub" }] },
};

const sandbox = {
  console, FormData: class { append() {} },
  document: { querySelector: get, querySelectorAll: () => [], createElement: (t) => el(t), title: "" },
  localStorage: { getItem: (k) => (k === "token" ? "stub" : null), setItem() {}, removeItem() {} },
  location: { reload() {} },
  fetch: async (url) => {
    const key = url.replace("http://x", "");
    const data = RESPONSES[key];
    if (data === undefined) throw new Error("unstubbed fetch: " + key);
    return { ok: true, status: 200, json: async () => (typeof data === "function" ? data() : data) };
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const errors = [];
process.on("unhandledRejection", (e) => errors.push("unhandledRejection: " + e.message));

let src = fs.readFileSync("public/icons.js", "utf8") + "\n" + fs.readFileSync("public/app.js", "utf8");
src += `
;globalThis.__t = {
  navEntries, go, buildNav, boot, NAV, DEFAULT_PAGE,
  sideIcon: (n) => sideIcon(n),
  navHtml: () => document.querySelector("#nav").innerHTML,
  crumbs: () => document.querySelector("#crumbs").textContent,
  setMe: (u) => { me = u; },
  getMe: () => me,
  run: async (label) => { const e = navEntries(me.role).find((x) => x.label === label); await e.fn(); },
  view: () => document.querySelector("#view").innerHTML,
  inner: (sel) => document.querySelector(sel).innerHTML,
  creditBox: () => document.querySelector("#credits"),
  creditHidden: () => document.querySelector("#credits").classList.contains("hidden"),
  roleLabel: () => document.querySelector("#me-role").textContent,
};`;

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "app.js" });
const t = sandbox.__t;
const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await wait(40);
  let pass = 0, fail = 0;
  const check = (n, c, e) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : " -> " + (typeof e === "string" ? e.slice(0, 160) : JSON.stringify(e)))); };
  const labels = (role) => t.navEntries(role).map((e) => e.label);
  const topOf = (role) => t.NAV[role].map((s) => s.label);

  check("boot rendered", Boolean(t.view()), "empty");
  check("brand applied", sandbox.document.title === "TestBrand", sandbox.document.title);

  // ---------------- client ----------------
  check("client nav is exactly Dashboard/Campaigns/Contacts/Wallet/Templates/Shortlinks/WhatsApp/Settings/Developers",
    JSON.stringify(labels("client")) === JSON.stringify(["Dashboard", "Campaigns", "Contacts", "Wallet", "Templates", "Shortlinks", "WhatsApp", "Settings", "Developers"]), labels("client").join(", "));
  check("client nav is flat (no collapsible sections)",
    topOf("client").every((l) => !t.NAV.client.find((s) => s.label === l && s.children)), topOf("client").join(", "));
  check("client credit box is visible", !t.creditHidden(), "hidden");
  check("client credit count shown", t.creditBox().textContent === "6 credits", t.creditBox().textContent);
  check("client is labelled Client", /^Client$/i.test(t.roleLabel()), t.roleLabel());
  for (const gone of ["Products", "Orders", "Store", "Customers", "Resellers", "Broadcast", "Analyse", "Governance"])
    check("client nav has no " + gone, !labels("client").includes(gone) && !topOf("client").includes(gone), labels("client").join(", "));

  const dash = t.view();
  check("client dashboard shows wallet credits", /<b>6<\/b><span>Wallet credits/.test(dash), dash.slice(0, 300));
  check("client dashboard shows credits used", /<b>4<\/b><span>Credits used/.test(dash), dash.slice(0, 300));
  check("client dashboard shows credits bought", /<b>10<\/b><span>Credits bought/.test(dash), dash.slice(0, 300));
  check("client dashboard counts campaigns", /<b>2<\/b><span>Campaigns sent/.test(dash), dash.slice(0, 400));
  check("client dashboard counts messages", /<b>4<\/b><span>Messages sent/.test(dash), dash.slice(0, 400));
  check("client dashboard counts contacts", /<b>2<\/b><span>Contacts/.test(dash), dash.slice(0, 400));
  check("client dashboard lists recent campaigns", /Recent campaigns/.test(dash) && /Diwali sale/.test(dash), dash.slice(0, 700));
  check("client dashboard never says Total users", !/Total users/.test(dash), dash.slice(0, 200));

  t.go("Contacts"); await wait();
  const ct = t.view();
  check("contacts page has an add form", /id="ct-name"/.test(ct) && /id="ct-phone"/.test(ct) && /id="ct-add"[^>]*>Add contact/.test(ct), ct.slice(0, 300));
  check("contacts page lists contacts", /Asha/.test(ct) && /Unnamed/.test(ct), ct.slice(0, 300));
  check("contacts page has a delete per contact", (ct.match(/data-del=/g) || []).length === 2, ct.slice(0, 400));
  check("contacts page escapes nothing raw", !/undefined/.test(ct), ct.slice(0, 300));

  t.go("Campaigns"); await wait();
  const camp = t.view();
  check("campaigns page renders the builder", /id="c-name"/.test(camp) && /id="c-tpl"/.test(camp) && /id="c-go"/.test(camp), camp.slice(0, 300));
  check("campaigns page lists saved contacts to pick", /pick-row/.test(camp) && /Asha/.test(camp), camp.slice(0, 600));
  check("campaigns page offers a numbers textarea", /id="c-numbers"/.test(camp), camp.slice(0, 500));
  check("campaign page offers only approved/simulated templates", /demo_template/.test(camp) && /helo_shape/.test(camp) && !/raw_id/.test(camp), camp.slice(0, 500));
  check("campaign page includes a hand-added template", /my_hand_template/.test(camp), camp.slice(0, 500));
  check("campaign page has no undefined option", !/>undefined</.test(camp), camp.slice(0, 300));
  check("campaign page shows the credit cost", /id="c-cost"/.test(camp) && /credit/i.test(camp), camp.slice(0, 300));

  t.go("Templates"); await wait(30);
  const tpl = t.view();
  const heloTpl = t.inner("#t-helo");
  const customTpl = t.inner("#t-custom");
  check("templates page shows Helo templates", /demo_template/.test(heloTpl), heloTpl.slice(0, 300));
  check("templates page has an add-your-own form", /id="t-name"/.test(tpl) && /id="t-add"[^>]*>Add template/.test(tpl), tpl.slice(0, 500));
  check("templates page lists hand-added templates with delete", /my_hand_template/.test(customTpl) && /data-del="7"/.test(customTpl), customTpl.slice(0, 600));
  check("templates page loads Helo and hand-added panels independently", /id="t-helo"/.test(tpl) && /id="t-custom"/.test(tpl), tpl.slice(0, 500));

  t.go("Wallet"); await wait();
  const wal = t.view();
  check("wallet shows the sell price per credit", /₹1\.00/.test(wal), wal.slice(0, 300));
  check("wallet shows a price calculator", /id="w-qty"/.test(wal) && /id="w-cost"/.test(wal), wal.slice(0, 300));
  check("wallet lists membership plans", /Starter/.test(wal) && /data-plan="1"/.test(wal), wal.slice(0, 500));
  check("wallet shows payment history", /100 credits/.test(wal) && /pending/.test(wal), wal.slice(0, 500));
  check("wallet offers a Buy credits button", /id="w-buy"[^>]*>Buy credits</.test(wal), wal.slice(0, 500));
  check("wallet no longer says Request credits", !/Request credits/.test(wal), wal.slice(0, 500));
  check("wallet shows the credit ledger", /Credit ledger/.test(wal) && /approved/.test(wal), wal.slice(0, 700));

  t.go("Settings"); await wait();
  const cSet = t.view();
  check("client settings link to WhatsApp instead of a raw sender field", /data-go="WhatsApp"/.test(cSet) && !/id="s-phone"/.test(cSet), cSet.slice(0, 300));
  check("client settings show the membership", /membership/i.test(cSet) && /Active until/.test(cSet), cSet.slice(0, 400));

  t.go("WhatsApp"); await wait();
  const cWa = t.view();
  check("client WhatsApp page has a connect field", /id="wa-phone"/.test(cWa) && /\+919876543210/.test(cWa), cWa.slice(0, 400));
  check("client WhatsApp page shows connected status", /Connected/i.test(cWa), cWa.slice(0, 400));
  check("client WhatsApp page has a save button", /id="wa-save"[^>]*>Save &amp; connect/.test(cWa), cWa.slice(0, 400));

  t.go("Developers"); await wait();
  const dev = t.view();
  check("developers page documents the client API", /\/api\/client\/contacts/.test(dev) && /\/api\/admin\/clients/.test(dev), dev.slice(0, 800));
  check("developers page reports simulated mode for a disconnected Helo", /Simulated/.test(dev), dev.slice(0, 400));

  for (const l of labels("client")) {
    errors.length = 0;
    try { t.go(l); await wait(); await t.run(l); check("client page renders: " + l, t.view().length > 40 && !errors.length, errors.join("; ") || t.view().slice(0, 80)); }
    catch (e) { check("client page renders: " + l, false, e.message); }
  }

  // ---------------- admin ----------------
  ME = ADMIN; await t.boot(); await wait();
  check("admin nav is exactly Dashboard/User management/Payments/Pricing/WhatsApp/Settings",
    JSON.stringify(topOf("admin")) === JSON.stringify(["Dashboard", "User management", "Payments", "Pricing", "WhatsApp", "Settings"]), topOf("admin").join(", "));
  check("admin nav flattens to Dashboard/Management/User wallet/Payments/Pricing/WhatsApp/Settings",
    JSON.stringify(labels("admin")) === JSON.stringify(["Dashboard", "Management", "User wallet", "Payments", "Pricing", "WhatsApp", "Settings"]), labels("admin").join(", "));
  const um = t.NAV.admin.find((s) => s.label === "User management");
  check("admin has a collapsible User management section with Management + User wallet",
    Boolean(um && um.children) && um.children.map((c) => c.label).join("/") === "Management/User wallet", um ? (um.children || []).map((c) => c.label).join("/") : "none");
  check("admin credit box is hidden", t.creditHidden(), "visible");
  check("admin is labelled Platform owner", /Platform owner/.test(t.roleLabel()), t.roleLabel());
  const aDash = t.view();
  check("admin dashboard counts clients", /<b>2<\/b><span>Clients/.test(aDash), aDash.slice(0, 300));
  check("admin dashboard sums campaigns run", /<b>2<\/b><span>Campaigns run/.test(aDash), aDash.slice(0, 300));
  check("admin dashboard sums credits held", /<b>6<\/b><span>Credits held/.test(aDash), aDash.slice(0, 300));
  check("admin dashboard shows client balances", /Atulya/.test(aDash), aDash.slice(0, 400));

  t.go("Management"); await wait();
  const rl = t.inner("#r-list");
  check("clients page lists accounts", /Atulya/.test(rl) && /Rival/.test(rl), rl.slice(0, 300));
  check("clients page shows credits", /6 credits/.test(rl) || /data-add="1"/.test(rl), rl.slice(0, 400));
  check("clients page has grant and remove controls", /data-add="1"/.test(rl) && /data-sub="1"/.test(rl), rl.slice(0, 400));
  check("clients page has a credit amount input", /id="amt-1"/.test(rl) && /class="mini"/.test(rl), rl.slice(0, 400));
  check("clients page shows membership and usage", /Active/.test(rl) && /used/.test(rl), rl.slice(0, 500));
  check("clients page has an error target", /id="p-err"/.test(t.view()), t.view().slice(0, 120));
  check("admin has no product or campaign tabs", !labels("admin").some((l) => ["Products", "Campaigns", "Store", "Broadcast"].includes(l)), labels("admin").join(", "));

  t.go("User wallet"); await wait();
  const uw = t.view();
  check("user wallet page lists clients to pick", /id="uw-client"/.test(uw) && /Atulya/.test(uw), uw.slice(0, 400));
  check("user wallet shows credit controls", /id="uw-add"/.test(t.inner("#uw-body")) && /id="uw-sub"/.test(t.inner("#uw-body")), t.inner("#uw-body").slice(0, 500));
  check("user wallet shows the ledger and payments", /Credit ledger/.test(t.inner("#uw-body")) && /Payment history/.test(t.inner("#uw-body")), t.inner("#uw-body").slice(0, 400));
  check("user wallet can add and delete a template for the client", /id="uw-tname"/.test(t.inner("#uw-body")) && /id="uw-tadd"/.test(t.inner("#uw-body")) && /my_hand_template/.test(t.inner("#uw-body")) && /data-uwdel="7"/.test(t.inner("#uw-body")), t.inner("#uw-body").slice(0, 600));

  t.go("WhatsApp"); await wait();
  const awa = t.view();
  check("admin WhatsApp page manages client templates", /id="aw-name"/.test(awa) && /id="aw-add"/.test(awa) && /my_hand_template/.test(awa), awa.slice(0, 600));
  check("admin WhatsApp page lists client sender numbers", /id="wa-1"/.test(awa) && /data-wa="1"/.test(awa), awa.slice(0, 700));
  check("admin WhatsApp page reports the provider", /WhatsApp connection/.test(awa) && /Approved templates/.test(awa), awa.slice(0, 400));

  t.go("Payments"); await wait();
  const pay = t.view();
  check("payments page lists a pending request", /Atulya/.test(pay) && /100 credits/.test(pay), pay.slice(0, 400));
  check("payments page offers approve and reject", /data-ok="5"/.test(pay) && /data-no="5"/.test(pay), pay.slice(0, 400));

  t.go("Pricing"); await wait();
  const pri = t.view();
  check("pricing page shows buy and sell inputs", /id="pr-buy"/.test(pri) && /id="pr-sell"/.test(pri), pri.slice(0, 400));
  check("pricing page lists plans with edit and delete", /Starter/.test(pri) && /data-pedit="1"/.test(pri) && /data-pdel="1"/.test(pri), pri.slice(0, 500));

  t.go("Settings"); await wait();
  const aSet = t.view();
  check("admin settings explain the admin account", /Admin account/.test(aSet), aSet.slice(0, 300));
  check("admin settings have no sender-number field", !/id="s-phone"/.test(aSet), aSet.slice(0, 300));

  check("every admin nav icon exists in the icon set", t.NAV.admin.concat(t.NAV.client).every((s) => t.sideIcon(s.icon).indexOf("<path") > 0), "missing icon");

  for (const l of labels("admin")) {
    errors.length = 0;
    try { t.go(l); await wait(); await t.run(l); check("admin page renders: " + l, t.view().length > 40 && !errors.length, errors.join("; ") || t.view().slice(0, 80)); }
    catch (e) { check("admin page renders: " + l, false, e.message); }
  }

  // ---------------- escaping ----------------
  RESPONSES["/api/client/contacts"] = [{ id: 9, name: '<img src=x onerror="boom()">', phone: "+919876543210", at: AT }];
  ME = CLIENT; await t.boot(); await wait(); t.go("Contacts"); await wait();
  const xss = t.view();
  check("contact name is HTML-escaped", !/onerror="boom\(\)"/.test(xss) && /&lt;img/.test(xss), xss.slice(0, 300));
  RESPONSES["/api/client/contacts"] = CONTACTS;

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
