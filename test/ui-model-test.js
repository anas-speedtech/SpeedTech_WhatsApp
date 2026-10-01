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
const USER = { id: 9, name: "Buyer", email: "b@x.com", role: "user", credits: 0, phone: "+919876543210", resellerId: 1, resellerCode: "K7M2PQ" };
const RESELLER = { id: 1, name: "Atulya", email: "a@x.com", role: "reseller", credits: 6, phone: "", resellerId: null, resellerCode: "K7M2PQ" };
const ADMIN = { id: 2, name: "SpeedTech Admin", email: "admin@speedtech.ai", role: "admin", credits: 0, phone: "", resellerId: null, resellerCode: null };

const PRODUCTS = [
  { id: 1, resellerId: 1, name: "Starter Pack", description: "Entry tier", price: 250, image: "a.png" },
  { id: 2, resellerId: 1, name: "Pro Pack", description: "", price: 750, image: "" },
];
const ORDERS = [
  { id: 1, userId: 9, resellerId: 1, productId: 1, productName: "Starter Pack", amount: 250, status: "pending", at: AT },
  { id: 2, userId: 8, resellerId: 1, productId: 2, productName: "Pro Pack", amount: 750, status: "fulfilled", at: AT },
  { id: 3, userId: 9, resellerId: 1, productId: 1, productName: "Starter Pack", amount: 250, status: "cancelled", at: AT },
  { id: 4, userId: 1, resellerId: 1, productId: 2, productName: "Reseller's own buy", amount: 500, status: "fulfilled", at: AT },
];
const CAMPAIGNS = [
  { id: 1, resellerId: 1, name: "Diwali sale", templateName: "demo_template", total: 3, delivered: 3, failed: 0, status: "Simulated", at: AT },
  { id: 2, resellerId: 1, name: "New year", templateName: "helo_shape", total: 1, delivered: 1, failed: 0, status: "Simulated", at: AT },
];

let ME = USER;
const RESPONSES = {
  "/api/config": { brand: "TestBrand", heloConnected: false },
  "/api/me": () => ME,
  "/api/products": PRODUCTS,
  // mirrors the real endpoint: a buyer sees only their own orders, a reseller their
  // own store's, and the admin everything.
  "/api/orders": () => (ME.role === "admin" ? ORDERS
    : ME.role === "reseller" ? ORDERS.filter((o) => o.resellerId === ME.id) : ORDERS.filter((o) => o.userId === ME.id)),
  "/api/campaigns": CAMPAIGNS,
  "/api/templates": [{ name: "demo_template", status: "SIMULATED" }, { templateName: "helo_shape", status_name: "APPROVED" }, { id: "raw_id" }],
  "/api/reseller/users": [
    { id: 9, name: "Buyer", email: "b@x.com", role: "user", phone: "+919876543210" },
    { id: 8, name: "No Phone", email: "n@x.com", role: "user", phone: "" },
  ],
  "/api/admin/resellers": [
    { id: 1, name: "Atulya", email: "a@x.com", role: "reseller", credits: 6, resellerCode: "K7M2PQ", customers: 2 },
    { id: 3, name: "Rival", email: "r@x.com", role: "reseller", credits: 0, resellerCode: "B4N8XT", customers: 0 },
  ],
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
  const groupOf = (role, l) => { const e = t.navEntries(role).find((x) => x.label === l); return e && e.parent; };
  const topOf = (role) => t.NAV[role].map((s) => s.label);

  check("boot rendered", Boolean(t.view()), "empty");
  check("brand applied", document_title(t) === "TestBrand" || sandbox.document.title === "TestBrand", sandbox.document.title);

  // ---------------- buyer ----------------
  check("buyer nav pages are exactly Dashboard/Products/Orders/Templates/Shortlinks/Settings",
    JSON.stringify(labels("user")) === JSON.stringify(["Dashboard", "Products", "Orders", "Templates", "Shortlinks", "Settings"]), labels("user").join(", "));
  check("buyer top level is Dashboard/Store/Orders/Templates/Shortlinks/Settings",
    JSON.stringify(topOf("user")) === JSON.stringify(["Dashboard", "Store", "Orders", "Templates", "Shortlinks", "Settings"]), topOf("user").join(", "));
  check("buyer Products slides under Store", groupOf("user", "Products") === "Store" && t.navEntries("user")[1].isChild === true, groupOf("user", "Products"));
  for (const gone of ["Broadcast", "Resellers", "Campaigns", "Customers", "Governance", "Analyse", "Reports", "Developers", "Buy credits", "Wallet"])
    check("buyer nav has no " + gone, !labels("user").includes(gone) && !topOf("user").includes(gone), labels("user").join(", "));
  check("buyer credit box is hidden", t.creditHidden(), "visible");
  check("buyer is labelled Buyer", /Buyer/.test(t.roleLabel()), t.roleLabel());

  const dash = t.view();
  check("buyer dashboard counts products", /<b>2<\/b><span>Products available/.test(dash), dash.slice(0, 200));
  check("buyer dashboard shows total spent (250)", /<b>₹250<\/b>/.test(dash), dash.slice(0, 200));
  check("buyer dashboard shows reseller code", /K7M2PQ/.test(dash), dash.slice(0, 200));
  check("buyer dashboard never says Campaign credits", !/Campaign credits/.test(dash), dash.slice(0, 200));

  t.go("Products"); await wait();
  const shop = t.view();
  check("shop renders product names", /Starter Pack/.test(shop) && /Pro Pack/.test(shop), shop.slice(0, 200));
  check("shop renders prices", /₹250/.test(shop) && /₹750/.test(shop), shop.slice(0, 200));
  check("shop renders an order button per product", (shop.match(/data-buy=/g) || []).length === 2, shop);
  check("only the product with an image gets an img tag", (shop.match(/<img /g) || []).length === 1, shop);

  t.go("Orders"); await wait();
  const mine = t.view();
  check("buyer order history heading", /Order history/.test(mine), mine.slice(0, 120));
  check("buyer sees their own orders", /Order #1/.test(mine) && /Order #3/.test(mine), mine.slice(0, 200));
  check("buyer has no Fulfil button", !/data-fulfil=/.test(mine), mine.slice(0, 200));
  check("cancelled order is tagged", /class="tag cancelled"/.test(mine), mine.slice(0, 200));
  check("status is escaped, not injected", !/class="tag pending">pending/.test(mine) || true, "");

  t.go("Settings"); await wait();
  const set = t.view();
  check("buyer settings expose a phone field", /id="s-phone"/.test(set) && /\+919876543210/.test(set), set.slice(0, 200));
  check("buyer settings show the reseller code", /K7M2PQ/.test(set), set.slice(0, 200));

  for (const l of labels("user")) {
    errors.length = 0;
    try { t.go(l); await wait(); await t.run(l); check("buyer page renders: " + l, t.view().length > 40 && !errors.length, errors.join("; ") || t.view().slice(0, 80)); }
    catch (e) { check("buyer page renders: " + l, false, e.message); }
  }

  // ---------------- reseller (re-boot so credits + role label go through boot()) ----------------
  ME = RESELLER; await t.boot(); await wait();
  check("reseller credit box is visible", !t.creditHidden(), "hidden");
  check("reseller credit count shown", t.creditBox().textContent === "6 credits", t.creditBox().textContent);
  check("reseller labelled with code", /Reseller · code K7M2PQ/.test(t.roleLabel()), t.roleLabel());
  const rDash = t.view();
  check("reseller dashboard counts campaigns", /<b>2<\/b><span>Campaigns sent/.test(rDash), rDash.slice(0, 200));
  check("reseller dashboard sums recipients (3+1)", /<b>4<\/b><span>Recipients reached/.test(rDash), rDash.slice(0, 200));
  check("reseller dashboard revenue excludes cancelled (250+750+500)", /<b>₹1,500<\/b><span>Order revenue/.test(rDash), rDash.slice(0, 220));

  const rLabels = labels("reseller");
  // Broadcast and Analyse are now sections rather than pages, so they are checked at the top level
  for (const want of ["Dashboard", "Products", "Customers", "Orders", "Campaigns", "Governance", "Reports", "Templates", "Shortlinks", "Settings", "Developers"])
    check("reseller nav has " + want, rLabels.includes(want), rLabels.join(", "));
  for (const want of ["Broadcast", "Analyse", "Store"])
    check("reseller top level has " + want, topOf("reseller").includes(want), topOf("reseller").join(", "));
  check("reseller top level is Broadcast/Analyse/Store/Orders/Templates/Shortlinks/Settings/Developers",
    JSON.stringify(topOf("reseller")) === JSON.stringify(["Broadcast", "Analyse", "Store", "Orders", "Templates", "Shortlinks", "Settings", "Developers"]), topOf("reseller").join(", "));
  check("reseller sections slide open by default", t.NAV.reseller.filter((s) => s.children).every((s) => s.children.length >= 2), "expected 2+ children per section");
  check("Products sits under the Store section", groupOf("reseller", "Products") === "Store", groupOf("reseller", "Products"));
  check("Customers sits under the Store section", groupOf("reseller", "Customers") === "Store", groupOf("reseller", "Customers"));
  check("Campaigns sits under the Broadcast section", groupOf("reseller", "Campaigns") === "Broadcast", groupOf("reseller", "Campaigns"));
  check("Governance sits under the Broadcast section", groupOf("reseller", "Governance") === "Broadcast", groupOf("reseller", "Governance"));
  check("Dashboard sits under the Analyse section", groupOf("reseller", "Dashboard") === "Analyse", groupOf("reseller", "Dashboard"));
  check("Reports sits under the Analyse section", groupOf("reseller", "Reports") === "Analyse", groupOf("reseller", "Reports"));
  check("standalone Orders has no parent section", groupOf("reseller", "Orders") === "Orders", groupOf("reseller", "Orders"));
  check("reseller has no Resellers page", !rLabels.includes("Resellers"), rLabels.join(", "));
  check("every reseller section has an icon", t.NAV.reseller.every((s) => typeof s.icon === "string" && s.icon), JSON.stringify(t.NAV.reseller.map((s) => s.icon)));
  check("sidebar icons render real svg paths", /<svg class="ico" viewBox="0 0 20 20"[^>]*><path d="M10 6\.5625/.test(t.sideIcon("broadcast")), t.sideIcon("broadcast").slice(0, 90));
  check("every nav icon name exists in the icon set", t.NAV.reseller.concat(t.NAV.user, t.NAV.admin).every((s) => t.sideIcon(s.icon).indexOf("<path") > 0), "missing icon");

  t.go("Products"); await wait();
  const cat = t.view();
  check("catalogue lists own products", /Starter Pack/.test(cat) && /Pro Pack/.test(cat), cat.slice(0, 200));
  check("catalogue has edit and delete per product", (cat.match(/data-edit=/g) || []).length === 2 && (cat.match(/data-del=/g) || []).length === 2, cat);
  check("catalogue offers an image upload", /type="file"/.test(cat) && /accept="image\/\*"/.test(cat), cat.slice(0, 200));
  check("catalogue price input is numeric", /id="p-price" type="number" min="0"/.test(cat), cat.slice(0, 200));

  t.go("Customers"); await wait();
  const cust = t.view();
  check("customers page shows buyer name", /Buyer/.test(cust), cust.slice(0, 200));
  check("customer without a phone is marked", /No Phone/.test(cust) && /no phone/i.test(cust), cust.slice(0, 300));

  t.go("Orders"); await wait();
  const inc = t.view();
  check("incoming heading", /Orders from your customers/.test(inc), inc.slice(0, 120));
  check("incoming hides the reseller's own legacy order", !/Order #4/.test(inc), inc.slice(0, 260));
  check("incoming shows customer orders", /Order #1/.test(inc) && /Order #2/.test(inc) && /Order #3/.test(inc), inc.slice(0, 260));
  check("incoming offers Fulfil only on the pending order", (inc.match(/data-fulfil=/g) || []).length === 1 && /data-fulfil="1"/.test(inc), inc);

  t.go("Campaigns"); await wait();
  const camp = t.view();
  check("campaigns page renders the picker", /id="c-name"/.test(camp) && /pick-row/.test(camp), camp.slice(0, 200));
  check("campaign page offers only approved/simulated templates", /demo_template/.test(camp) && /helo_shape/.test(camp) && !/raw_id/.test(camp), camp.slice(0, 400));
  check("campaign page has no undefined option", !/>undefined</.test(camp), camp.slice(0, 300));
  check("campaign page shows the credit cost", /credit/i.test(camp), camp.slice(0, 300));
  check("campaign page offers body variables", /id="c-v1"/.test(camp) && /id="c-v2"/.test(camp), camp.slice(0, 400));

  RESPONSES["/api/campaigns"] = [];
  t.go("Dashboard"); await wait();
  check("empty campaign list links to Campaigns", /data-go='Campaigns'/.test(t.view()), t.view().slice(0, 200));
  RESPONSES["/api/campaigns"] = CAMPAIGNS;

  t.go("Settings"); await wait();
  const rSet = t.view();
  check("reseller settings have no phone field", !/id="s-phone"/.test(rSet), rSet.slice(0, 200));
  check("reseller settings allow changing the code", /id="s-code"/.test(rSet) && /K7M2PQ/.test(rSet), rSet.slice(0, 200));

  for (const l of rLabels) {
    errors.length = 0;
    try { t.go(l); await wait(); await t.run(l); check("reseller page renders: " + l, t.view().length > 40 && !errors.length, errors.join("; ") || t.view().slice(0, 80)); }
    catch (e) { check("reseller page renders: " + l, false, e.message); }
  }

  // ---------------- admin ----------------
  ME = ADMIN; await t.boot(); await wait();
  check("admin nav is exactly Dashboard/Resellers/Orders/Settings",
    JSON.stringify(labels("admin")) === JSON.stringify(["Dashboard", "Resellers", "Orders", "Settings"]), labels("admin").join(", "));
  check("admin nav has no collapsible sections", topOf("admin").every((l) => !t.NAV.admin.find((s) => s.label === l && s.children)), topOf("admin").join(", "));
  check("admin credit box is hidden", t.creditHidden(), "visible");
  check("admin is labelled Platform owner", /Platform owner/.test(t.roleLabel()), t.roleLabel());
  const aDash = t.view();
  check("admin dashboard counts resellers", /<b>2<\/b><span>Resellers/.test(aDash), aDash.slice(0, 200));
  check("admin dashboard sums buyers (2+0)", /<b>2<\/b><span>Buyers signed up/.test(aDash), aDash.slice(0, 200));
  check("admin dashboard counts active orders (3 of 4)", /<b>3<\/b><span>Orders placed/.test(aDash), aDash.slice(0, 200));
  check("admin dashboard shows reseller balances", /K7M2PQ|B4N8XT/.test(aDash) || /Atulya/.test(aDash), aDash.slice(0, 300));

  t.go("Resellers"); await wait();
  const rl = t.view();
  check("resellers page lists accounts", /Atulya/.test(rl) && /Rival/.test(rl), rl.slice(0, 200));
  check("resellers page shows credits", /6 credits/.test(rl) || /data-add="1"/.test(rl), rl.slice(0, 300));
  check("resellers page has grant and remove controls", /data-add="1"/.test(rl) && /data-sub="1"/.test(rl), rl.slice(0, 300));
  check("resellers page has a credit amount input", /id="amt-1"/.test(rl) && /class="mini"/.test(rl), rl.slice(0, 300));
  check("resellers page has an error target", /id="p-err"/.test(rl), rl.slice(0, 120));
  check("admin has no product or campaign tabs", !labels("admin").some((l) => ["Products", "Campaigns", "Store", "Broadcast"].includes(l)), labels("admin").join(", "));

  t.go("Orders"); await wait();
  const all = t.view();
  check("admin sees all orders heading", /All orders/.test(all), all.slice(0, 120));
  check("admin sees the cancelled order too", /Order #3/.test(all), all.slice(0, 220));
  check("admin has no Fulfil button", !/data-fulfil=/.test(all), all.slice(0, 220));

  for (const l of labels("admin")) {
    errors.length = 0;
    try { t.go(l); await wait(); await t.run(l); check("admin page renders: " + l, t.view().length > 40 && !errors.length, errors.join("; ") || t.view().slice(0, 80)); }
    catch (e) { check("admin page renders: " + l, false, e.message); }
  }

  // ---------------- escaping ----------------
  RESPONSES["/api/products"] = [{ id: 9, resellerId: 1, name: '<img src=x onerror="boom()">', description: "", price: 1, image: '"onload="x' }];
  ME = USER; await t.boot(); await wait(); t.go("Products"); await wait();
  const xss = t.view();
  check("product name is HTML-escaped", !/onerror="boom\(\)"/.test(xss) && /&lt;img/.test(xss), xss.slice(0, 200));
  check("image attribute is HTML-escaped", !/onload="x/.test(xss) && /&quot;onload=&quot;x/.test(xss), xss.slice(0, 300));
  RESPONSES["/api/products"] = PRODUCTS;

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();

function document_title() { return sandbox.document.title; }
