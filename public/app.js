const $ = (s) => document.querySelector(s);
let token = localStorage.getItem("token"), me = null, cfg = {}, mode = "login";
let editingProduct = null;

async function api(path, method = "GET", body) {
  const isForm = body instanceof FormData;
  const res = await fetch("/api" + path, { method,
    headers: { ...(body && !isForm ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

// ---------- auth screen ----------
function setMode(m) {
  mode = m;
  $("#auth-title").textContent = m === "login" ? "Sign in" : "Create account";
  $("#a-go").textContent = m === "login" ? "Sign in" : "Create account";
  $("#a-toggle").textContent = m === "login" ? "New here? Create an account" : "Have an account? Sign in";
  document.querySelectorAll(".reg").forEach((e) => e.classList.toggle("hidden", m === "login"));
  syncRole();
}
function syncRole() {
  const r = $("#a-role").value;
  document.querySelectorAll(".user-only").forEach((e) => e.classList.toggle("hidden", mode === "login" || r !== "user"));
  document.querySelectorAll(".reseller-only").forEach((e) => e.classList.toggle("hidden", mode === "login" || r !== "reseller"));
}
$("#a-role").onchange = syncRole;
$("#a-toggle").onclick = () => setMode(mode === "login" ? "register" : "login");
$("#a-go").onclick = async () => {
  $("#a-err").textContent = "";
  try {
    const body = { email: $("#a-email").value, password: $("#a-pass").value };
    if (mode === "register") Object.assign(body, { name: $("#a-name").value, role: $("#a-role").value,
      resellerCode: $("#a-code").value.trim(), signupCode: $("#a-signup").value, phone: $("#a-phone").value.trim() });
    const r = await api(mode === "login" ? "/auth/login" : "/auth/register", "POST", body);
    token = r.token; localStorage.setItem("token", token); boot();
  } catch (e) { $("#a-err").textContent = e.message; }
};
$("#logout").onclick = () => { localStorage.removeItem("token"); token = null; location.reload(); };

// ---------- app shell ----------
const coming = (title, body) => async () => {
  $("#view").innerHTML = `<div class="panel"><h3>${title}</h3><p class="empty">${body}</p></div>`;
};

// Sidebar shape follows Helo Broadcast: a few top-level sections that slide open to reveal
// their sub-pages, plus standalone leaves. Every page the panel had before is still here --
// Broadcast and Analyse are now grouped rather than listed flat.
const NAV = {
  user: [
    { label: "Dashboard", icon: "dashboard", fn: dashboard },
    { label: "Store", icon: "store", children: [{ label: "Products", fn: shop }] },
    { label: "Orders", icon: "orders", fn: () => orders("mine") },
    { label: "Templates", icon: "templates", fn: templates },
    { label: "Shortlinks", icon: "shortlinks", fn: coming("Shortlinks", "Tracked links you can drop into a template to measure clicks. Not built yet (TODO 4).") },
    { label: "Settings", icon: "settings", fn: settings },
  ],
  reseller: [
    {
      label: "Broadcast", icon: "broadcast", children: [
        { label: "Campaigns", fn: campaigns },
        { label: "Governance", fn: coming("Governance", "Template approval status, opt-out and block lists, and your WhatsApp quality rating. Not built yet — these need delivery webhooks (TODO 3) before there is anything real to show.") },
      ],
    },
    {
      label: "Analyse", icon: "analyse", children: [
        { label: "Dashboard", fn: dashboard },
        { label: "Reports", fn: coming("Reports", "Downloadable summaries of orders, campaigns sent and revenue, plus per-campaign delivered, read and reply rates. Not built yet — the delivery numbers arrive only once Helo DLR webhooks are connected (TODO 3), and the exports with them (TODO 4).") },
      ],
    },
    {
      label: "Store", icon: "store", children: [
        { label: "Products", fn: products },
        { label: "Customers", fn: customers },
      ],
    },
    { label: "Orders", icon: "orders", fn: () => orders("incoming") },
    { label: "Templates", icon: "templates", fn: templates },
    { label: "Shortlinks", icon: "shortlinks", fn: coming("Shortlinks", "Tracked links you can drop into a template to measure clicks. Not built yet (TODO 4).") },
    { label: "Settings", icon: "settings", fn: settings },
    { label: "Developers", icon: "developers", fn: developers },
  ],
  admin: [
    { label: "Dashboard", icon: "dashboard", fn: dashboard },
    { label: "Resellers", icon: "store", fn: resellers },
    { label: "Orders", icon: "orders", fn: () => orders("all") },
    { label: "Settings", icon: "settings", fn: settings },
  ],
};

const DEFAULT_PAGE = { user: "Dashboard", reseller: "Dashboard", admin: "Dashboard" };

// A section either has children or is itself a page. Flatten both into one list of pages,
// remembering which section each one hangs under so go() can expand and light up the parent.
const navEntries = (role) => NAV[role].flatMap((s) => {
  const kids = s.children || [{ label: s.label, fn: s.fn }];
  return kids.map((c) => ({ ...c, parent: s.label, section: s, isChild: !!s.children }));
});

// which sections are slid open, remembered per role
const expKey = () => `nav.open.${me.role}`;
function openSections() {
  try { return new Set(JSON.parse(localStorage.getItem(expKey()) || "null") ?? NAV[me.role].map((s) => s.label)); }
  catch { return new Set(NAV[me.role].map((s) => s.label)); }
}
function saveOpen() {
  try { localStorage.setItem(expKey(), JSON.stringify([...openSet])); } catch {}
}
let openSet = new Set();
function setOpen(label, on) {
  if (on) openSet.add(label); else openSet.delete(label);
  saveOpen();
  // iterate rather than query by name so nothing depends on CSS.escape
  const sec = [...$("#nav").querySelectorAll("[data-section]")].find((b) => b.dataset.section === label);
  if (sec) {
    sec.classList.toggle("open", on);
    sec.querySelector(".nav-caret").setAttribute("aria-expanded", String(on));
  }
}

function go(name) {
  const entry = navEntries(me.role).find((e) => e.label === name);
  if (!entry) return;
  // reveal the child if its parent was slid shut
  if (entry.isChild && !openSet.has(entry.parent)) setOpen(entry.parent, true);
  document.querySelectorAll("#nav [data-page]").forEach((b) => b.classList.toggle("on", b.dataset.page === name));
  document.querySelectorAll("#nav [data-section]").forEach((b) => b.classList.toggle("active", b.dataset.section === entry.parent));
  $("#page-title").textContent = name;
  $("#crumbs").innerHTML = entry.isChild ? `<span>${esc(entry.parent)}</span><i>/</i><b>${esc(name)}</b>` : "";
  // every view function overwrites #view once its data lands, so the inline ring only
  // shows while those fetches are in flight. Self-refreshes (campaigns() re-rendering
  // after a send) call the view directly and so do not flash it.
  $("#view").innerHTML = `<div class="splash-inline">${RING}</div>`;
  Promise.resolve(entry.fn()).catch((e) => { $("#view").innerHTML = `<p class="err">${esc(e.message || e)}</p>`; });
}

function buildNav() {
  const nav = $("#nav");
  nav.innerHTML = "";
  openSet = openSections();
  for (const s of NAV[me.role]) {
    if (!s.children) { nav.append(navBtn(s.label, s.icon, false)); continue; }
    const sec = document.createElement("div");
    sec.className = "nav-sec" + (openSet.has(s.label) ? " open" : "");
    sec.dataset.section = s.label;

    const head = document.createElement("button");
    head.className = "nav-head";
    head.type = "button";
    head.innerHTML = `${sideIcon(s.icon)}<span class="nav-label">${esc(s.label)}</span>`
      + `<span class="nav-caret" aria-expanded="${openSet.has(s.label)}" aria-label="Toggle ${esc(s.label)}">`
      + `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7.5 8.75L10 11.25L12.5 8.75" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
    head.onclick = () => setOpen(s.label, !openSet.has(s.label));
    sec.append(head);

    const sub = document.createElement("div");
    sub.className = "nav-sub";
    s.children.forEach((c) => sub.append(navBtn(c.label, null, true)));
    sec.append(sub);
    nav.append(sec);
  }
}

const navBtn = (label, icon, isChild) => {
  const b = document.createElement("button");
  b.className = "nav-item" + (isChild ? " child" : "");
  b.type = "button";
  b.dataset.page = label;
  // a child has no icon of its own; the section header carries the glyph
  b.innerHTML = (icon ? sideIcon(icon) : `<span class="nav-dot"></span>`) + `<span class="nav-label">${esc(label)}</span>`;
  b.onclick = () => go(label);
  return b;
};

// public/logo.png is the icon cropped to its tight bounding box (131x66). The source
// file has wide transparent margins, so a bare object-fit:contain would shrink the mark.
const SHOW_TEXT_WITH_LOGO = true;

// Sidebar can collapse to an icon-only rail, the way Helo's does
function applySide() {
  const on = localStorage.getItem("nav.rail") === "1";
  $("#app").classList.toggle("rail", on);
  $("#side-toggle").setAttribute("aria-label", on ? "Expand sidebar" : "Collapse sidebar");
}
$("#side-toggle").onclick = () => {
  const on = $("#app").classList.toggle("rail");
  localStorage.setItem("nav.rail", on ? "1" : "0");
  $("#side-toggle").setAttribute("aria-label", on ? "Expand sidebar" : "Collapse sidebar");
};

// ---------- boot splash ----------
// Helo shows a spinning ring while the app boots and while a view's data loads. Ours is
// the same pattern: #splash covers first paint, and .splash-inline is the smaller copy
// swapped into #view by go().
const RING = '<div class="ring-wrap"><div class="ring"></div><img class="ring-mark" src="logo.png" alt=""></div>';
const hideSplash = () => $("#splash").classList.add("hidden");
// A dead /api/config used to leave a blank white page with no way forward.
function splashError(err) {
  const s = $("#splash");
  s.classList.remove("hidden");
  $("#splash-msg").textContent = `Could not reach the panel: ${err.message || err}`;
  $("#splash-retry").classList.remove("hidden");
  $("#splash-retry").onclick = () => { s.classList.add("hidden"); boot(); };
}

async function boot() {
  try {
    cfg = await api("/config");
  } catch (e) { return splashError(e); }
  document.title = cfg.brand;
  document.querySelectorAll(".brand-name").forEach((e) => {
    e.textContent = cfg.brand;
    e.style.display = SHOW_TEXT_WITH_LOGO ? "" : "none";
  });
  document.querySelectorAll(".logo").forEach((e) => (e.alt = cfg.brand));
  if (!token) { hideSplash(); $("#auth").classList.remove("hidden"); setMode("login"); return; }
  try { me = await api("/me"); } catch { localStorage.removeItem("token"); token = null; return boot(); }
  hideSplash();
  $("#auth").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#me-name").textContent = me.name;
  $("#me-role").textContent = me.role === "reseller" ? `Reseller · code ${me.resellerCode}`
    : me.role === "admin" ? "Platform owner" : "Buyer";
  buildNav();
  applySide();
  showCredits(); go(DEFAULT_PAGE[me.role] || navEntries(me.role)[0].label);
}
function showCredits() {
  // only the reseller holds campaign credits; buyers and the admin do not
  $("#credits").classList.toggle("hidden", me.role !== "reseller");
  if (me.role === "reseller") $("#credits").textContent = `${me.credits} credits`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const list = (items, fn, empty) => items.length ? items.map(fn).join("") : `<p class="empty">${empty}</p>`;
const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;
// lowercased and hyphenated so a status like "In-Draft" maps onto a real css class
const statusTag = (s) => `<span class="tag ${esc(String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-"))}">${esc(s)}</span>`;
const card = (n, label) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`;
// Helo's real template shape is not finalised yet, so read it defensively
const tplName = (t) => esc(t.name || t.templateName || t.template_name || t.id || "(unnamed)");
const tplStatus = (t) => t.status || t.status_name || t.category || t.language || "";
const productForm = (p) => {
  const f = new FormData();
  f.append("name", $("#p-name").value.trim());
  f.append("description", $("#p-desc").value.trim());
  f.append("price", $("#p-price").value);
  const file = $("#p-img").files[0];
  if (file && file.size) f.append("image", file);
  return f;
};

// ---------- dashboards ----------
async function dashboard() {
  if (me.role === "admin") return adminDashboard();
  if (me.role === "reseller") {
    const [cs, os] = await Promise.all([api("/campaigns"), api("/orders")]);
    const reached = cs.reduce((n, c) => n + c.total, 0);
    const live = os.filter((o) => o.status !== "cancelled");
    $("#view").innerHTML = `
      <div class="stats">
        ${card(me.credits, "Campaign credits")}
        ${card(cs.length, "Campaigns sent")}
        ${card(reached, "Recipients reached")}
        ${card(money(live.reduce((n, o) => n + o.amount, 0)), "Order revenue")}
      </div>
      ${os.some((o) => o.status === "pending") ? `<div class="panel"><p>${os.filter((o) => o.status === "pending").length} order(s) waiting. <button class="link" data-go="Orders">Review them</button>.</p></div>` : ""}
      <div class="panel"><h3>Recent campaigns</h3>${list(cs.slice(0, 5), (c) =>
        `<div class="item"><div><strong>${esc(c.name)}</strong><small>${esc(c.templateName)} · ${c.total} recipients · ${new Date(c.at).toLocaleDateString()}</small></div><span class="tag">${esc(c.status)}</span></div>`,
        "No campaigns yet. <button class='link' data-go='Campaigns'>Send your first one</button>.")}</div>`;
  } else {
    const [ps, os] = await Promise.all([api("/products"), api("/orders")]);
    const live = os.filter((o) => o.status !== "cancelled");
    $("#view").innerHTML = `
      <div class="stats">
        ${card(ps.length, "Products available")}
        ${card(os.length, "Orders placed")}
        ${card(money(live.reduce((n, o) => n + o.amount, 0)), "Total spent")}
        ${card(me.resellerCode || "-", "Your reseller")}
      </div>
      <div class="panel"><h3>Recent orders</h3>${list(os.slice(0, 5), (o) =>
        `<div class="item"><div><strong>${esc(o.productName || "Product")}</strong><small>${new Date(o.at).toLocaleDateString()}</small></div>${statusTag(o.status)}</div>`,
        "No orders yet. <button class='link' data-go='Products'>Browse products</button>.")}</div>`;
  }
  document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
}
async function adminDashboard() {
  const [rs, os] = await Promise.all([api("/admin/resellers"), api("/orders")]);
  const live = os.filter((o) => o.status !== "cancelled");
  $("#view").innerHTML = `
    <div class="stats">
      ${card(rs.length, "Resellers")}
      ${card(rs.reduce((n, r) => n + r.customers, 0), "Buyers signed up")}
      ${card(live.length, "Orders placed")}
      ${card(money(live.reduce((n, o) => n + o.amount, 0)), "Gross order value")}
    </div>
    <div class="panel"><h3>Reseller balances</h3>${list(rs, (r) =>
      `<div class="item"><div><strong>${esc(r.name)}</strong><small>${esc(r.email)}</small></div>
        <div class="row-inline"><span class="tag">${r.credits} credits</span><button class="btn" data-go="Resellers">Manage</button></div></div>`,
      "No resellers yet.")}</div>`;
  document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
}

// ---------- buyer: shop + orders ----------
async function shop() {
  const ps = await api("/products");
  $("#view").innerHTML = `
    <div class="panel"><h3>Products from your reseller</h3>
      ${ps.length ? `<div class="grid">${ps.map((p) => `
        <div class="pcard">
          <div class="pimg">${p.image ? `<img src="/uploads/${esc(p.image)}" alt="${esc(p.name)}">` : ""}</div>
          <h4>${esc(p.name)}</h4>
          ${p.description ? `<p>${esc(p.description)}</p>` : ""}
          <div class="prow"><strong>${money(p.price)}</strong><button class="btn" data-buy="${p.id}">Order now</button></div>
        </div>`).join("")}</div>`
      : `<p class="empty">Your reseller hasn't added any products yet.</p>`}
      <p id="p-err" class="err"></p>
    </div>`;
  document.querySelectorAll("[data-buy]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { await api("/orders", "POST", { productId: +b.dataset.buy }); go("Orders"); }
    catch (e) { $("#p-err").textContent = e.message; }
  }));
}

// ---------- shared / reseller / admin pages ----------
// kind: "mine" = buyer's orders, "incoming" = orders a reseller must fulfil, "all" = admin
async function orders(kind) {
  const all = await api("/orders");
  const os = kind === "incoming" ? all.filter((o) => o.userId !== me.id) : all;
  const heading = kind === "mine" ? "Order history" : kind === "incoming" ? "Orders from your customers" : "All orders";
  const live = os.filter((o) => o.status !== "cancelled");
  $("#view").innerHTML = `<div class="panel"><h3>${heading}</h3>
    ${os.length ? `<p class="empty">${live.length} active · ${money(live.reduce((n, o) => n + o.amount, 0))} total</p>` : ""}
    ${list(os, (o) => `<div class="item">
      <div><strong>${esc(o.productName || "Product")}</strong>
        <small>Order #${o.id} · ${new Date(o.at).toLocaleString()}</small></div>
      <div class="row-inline"><span class="tag">${money(o.amount)}</span>${statusTag(o.status)}
      ${kind === "incoming" && o.status === "pending" ? `<button class="btn" data-fulfil="${o.id}">Fulfil</button>` : ""}</div></div>`,
    kind === "mine" ? "No orders yet. <button class='link' data-go='Products'>Browse products</button>."
      : kind === "incoming" ? "No customer orders yet. Share your reseller code to get started."
      : "No orders yet.")}</div>
    <p id="p-err" class="err"></p>`;
  document.querySelectorAll("[data-fulfil]").forEach((b) => (b.onclick = async () => {
    try { await api("/orders/" + b.dataset.fulfil, "PATCH", { status: "fulfilled" }); orders(kind); }
    catch (e) { $("#p-err").textContent = e.message; }
  }));
  document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
}

async function products() {
  const ps = await api("/products");
  const editing = editingProduct;
  $("#view").innerHTML = `
    <div class="panel"><h3>${editing ? "Edit product" : "Add a product"}</h3>
      <div class="row">
        <input id="p-name" placeholder="Product name" value="${editing ? esc(editing.name) : ""}">
        <input id="p-price" type="number" min="0" step="0.01" placeholder="Price (₹)" value="${editing ? editing.price : ""}">
      </div>
      <textarea id="p-desc" rows="2" placeholder="Describe the product">${editing ? esc(editing.description) : ""}</textarea>
      <p class="empty">Product image — JPG, PNG, WebP or GIF up to 5MB. Leave empty to keep the current one.</p>
      <input id="p-img" type="file" accept="image/*">
      <p id="p-err" class="err"></p>
      <div class="row">
        <button id="p-go" class="btn">${editing ? "Save changes" : "Add product"}</button>
        ${editing ? `<button id="p-cancel" class="btn ghost">Cancel</button>` : ""}
      </div></div>
    <div class="panel"><h3>Your products</h3>${list(ps, (p) => `<div class="item">
      <div><strong>${esc(p.name)}</strong><small>${esc(p.description || "No description")}</small></div>
      <div class="row-inline"><span class="tag">${money(p.price)}</span>
        <button class="btn ghost" data-edit="${p.id}">Edit</button>
        <button class="btn ghost danger" data-del="${p.id}">Delete</button></div></div>`,
      "No products yet. Add your first one above.")}</div>`;
  if ($("#p-cancel")) $("#p-cancel").onclick = () => { editingProduct = null; products(); };
  $("#p-go").onclick = async () => {
    $("#p-err").textContent = "";
    try {
      if (editing) await api("/products/" + editing.id, "PUT", productForm());
      else await api("/products", "POST", productForm());
      editingProduct = null; products();
    } catch (e) { $("#p-err").textContent = e.message; }
  };
  document.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => {
    editingProduct = ps.find((p) => p.id === +b.dataset.edit); products();
  }));
  document.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this product?")) return;
    try { await api("/products/" + b.dataset.del, "DELETE"); products(); }
    catch (e) { $("#p-err").textContent = e.message; }
  }));
}

async function customers() {
  const us = await api("/reseller/users");
  const missing = us.filter((u) => !u.phone).length;
  $("#view").innerHTML = `<div class="panel">
    <p>Share your code <strong>${esc(me.resellerCode)}</strong> so customers can sign up under you.</p>
    ${missing ? `<p class="empty">${missing} customer(s) have no phone number, so they can't be campaign targets yet. They can add one from their Settings page.</p>` : ""}
    ${list(us, (u) => `<div class="item"><div><strong>${esc(u.name)}</strong><small>${esc(u.email)}</small></div>
      <div class="row-inline"><span class="tag ${u.phone ? "" : "none"}">${u.phone ? esc(u.phone) : "no phone"}</span></div></div>`,
    "No customers yet.")}</div>`;
}

// The campaign list is also repainted on its own while a background send is running,
// so it lives outside campaigns() and takes fresh data.
const campaignsListMarkup = (cs) => `<div class="panel"><h3>Your campaigns</h3>${list(cs, (c) =>
  `<div class="item"><div><strong>${esc(c.name)}</strong><small>${esc(c.templateName)}${c.templateCategory ? " · " + esc(c.templateCategory) : ""}${c.templateLanguage ? " · " + esc(c.templateLanguage) : ""} · ${c.total} targeted · ${new Date(c.at).toLocaleDateString()}</small>
    ${c.error ? `<small class="err">${esc(c.error)}</small>` : ""}
    ${(c.failures || []).filter((f) => f.phone).length ? `<small class="err">${c.failures.filter((f) => f.phone).length} failed: ${esc(c.failures.filter((f) => f.phone).slice(0, 3).map((f) => f.phone).join(", "))}</small>` : ""}</div>
    <div class="row-inline">${statusTag(c.status)}
    ${c.status === "Sending" ? `<span class="tag">${c.accepted || 0} / ${c.total} sent</span>` : ""}
    ${c.rejected ? `<span class="tag">${c.rejected} rejected</span>` : ""}</div></div>`,
  "No campaigns yet.")}</div>`;

async function campaigns() {
  const [cs, ts, us] = await Promise.all([api("/campaigns"), api("/templates"), api("/reseller/users")]);
  const selectable = us.filter((u) => u.phone);
  const missing = us.length - selectable.length;
  // Helo only accepts APPROVED templates, and needs the category + language with the name
  const usable = ts.filter((t) => tplStatus(t) === "APPROVED" || tplStatus(t) === "SIMULATED");
  const tplLabel = (t) => [tplName(t), tplStatus(t), t.category, t.language].filter(Boolean).join(" · ");
  $("#view").innerHTML = `
    <div class="panel"><h3>New campaign</h3>
      ${cfg.heloConnected ? "" : "<p class='empty'>Helo API not connected yet — campaigns are simulated.</p>"}
      ${!usable.length ? `<p class="empty">No approved templates available. Create and get one approved in Helo first.</p>` : ""}
      <div class="row"><input id="c-name" placeholder="Campaign name">
        <select id="c-tpl">${usable.map((t, i) => `<option value="${i}">${esc(tplLabel(t))}</option>`).join("")}</select></div>
      <div class="row">
        <input id="c-v1" placeholder="Body variable 1 (optional, same for everyone)">
        <input id="c-v2" placeholder="Body variable 2 (optional)"></div>
      <p class="empty">Leave the variable boxes empty unless the template body has {{1}}-style placeholders.</p>
      <div class="pick">
        <div class="pick-head"><strong>Send to</strong>
          <span><b id="c-count">0</b> selected · needs <b id="c-cost">0</b> credits (you have ${me.credits})</span>
          <button id="c-all" class="link">Select all</button></div>
        ${selectable.length ? selectable.map((u) => `<label class="pick-row">
          <input type="checkbox" value="${u.id}"><span>${esc(u.name)}</span><small>${esc(u.phone)}</small></label>`).join("")
          : `<p class="empty">No customers with a phone number yet.</p>`}
      </div>
      ${missing ? `<p class="empty">${missing} customer(s) skipped — no phone number on file.</p>` : ""}
      <p id="c-err" class="err"></p><button id="c-go" class="btn"${usable.length ? "" : " disabled"}>Send campaign</button></div>
    ${campaignsListMarkup(cs)}`;
  const boxes = [...document.querySelectorAll(".pick-row input")];
  const chosen = () => boxes.filter((b) => b.checked).map((b) => +b.value);
  const recount = () => { const n = chosen().length; $("#c-count").textContent = n; $("#c-cost").textContent = n; };
  boxes.forEach((b) => (b.onchange = recount));
  $("#c-all").onclick = () => { const on = boxes.some((b) => !b.checked); boxes.forEach((b) => (b.checked = on)); recount(); };
  $("#c-go").onclick = async () => {
    $("#c-err").textContent = "";
    const t = usable[+$("#c-tpl").value] || usable[0];
    if (!t) { $("#c-err").textContent = "No approved template to send"; return; }
    const vars = [$("#c-v1").value.trim(), $("#c-v2").value.trim()].filter(Boolean);
    // keyed by the digits Helo expects, matching how sendBulkTemplate looks them up
    const params = {};
    if (vars.length) for (const u of us) if (u.phone && chosen().includes(u.id)) params[u.phone.replace(/\D/g, "")] = vars;
    try {
      const r = await api("/campaigns", "POST", { name: $("#c-name").value,
        templateName: tplName(t), templateCategory: t.category || "", templateLanguage: t.language || "en",
        customerIds: chosen(), params });
      me.credits = r.credits; showCredits(); campaigns();
      if (r.campaign && r.campaign.status === "Sending") pollSending();
    } catch (e) { $("#c-err").textContent = e.message; }
  };
  // Sending now happens in the background one message at a time, so refresh while
  // any campaign is still going. Re-rendering the view would steal focus from the
  // form, so only the list is repainted, and only while something is in flight.
  let pollTimer = null;
  const pollSending = async () => {
    clearTimeout(pollTimer);
    let cs;
    try { cs = await api("/campaigns"); } catch (e) { return; }
    if (!cs.some((c) => c.status === "Sending")) return;
    if ($("#view") && $("#view").dataset.view === "campaigns") {
      const panel = $("#view").children[1];
      if (panel) panel.outerHTML = campaignsListMarkup(cs);
    }
    pollTimer = setTimeout(pollSending, 2000);
  };
  $("#view").dataset.view = "campaigns";
}

async function templates() {
  const ts = await api("/templates");
  $("#view").innerHTML = `
    <div class="panel"><h3>Your templates</h3>
      <p class="empty">${cfg.heloConnected
        ? "Templates are read from your Helo business account."
        : "Helo is not connected yet, so this is a placeholder list. Connect the Helo API (helo.js) to load your real approved templates."}</p>
      ${list(ts, (t) => `<div class="item"><div><strong>${tplName(t)}</strong>
        <small>${esc(tplStatus(t) || "Approved")}</small></div>
        <span class="tag">${esc(tplStatus(t) || "ready")}</span></div>`, "No templates available.")}</div>
    <div class="panel"><h3>Add your own</h3><p class="empty">Creating and editing templates inside the panel is not built yet — do it in Helo for now and they will appear here (TODO 4).</p></div>`;
}

async function developers() {
  // the health check is admin-only, so resellers get the simple configured/not view
  const canProbe = me.role === "admin";
  let helo = null;
  if (canProbe) {
    helo = { ok: false, reason: "Not checked" };
    try { helo = await api("/helo/status"); } catch (e) { helo = { ok: false, reason: e.message }; }
  }
  const tag = (ok, yes, no) => `<span class="tag ${ok ? "fulfilled" : "cancelled"}">${ok ? yes : no}</span>`;
  $("#view").innerHTML = `
    ${helo ? `<div class="panel"><h3>WhatsApp connection</h3>
      <div class="item"><div><strong>Credentials</strong><small>${esc(helo.reason || helo.error || "signed in and reachable")}</small></div>
        ${tag(helo.ok, "Working", "Not working")}</div>
      ${helo.ok ? `
        <div class="item"><div><strong>Host</strong><small>${esc(helo.baseUrl)}</small></div><span class="tag">${helo.wabas && helo.wabas.length} WABA(s)</span></div>
        <div class="item"><div><strong>Sender number</strong><small>${helo.from ? esc(helo.from) : "HELO_FROM is not set, so nothing can be sent"}</small></div>
          ${tag(Boolean(helo.from), "Set", "Missing")}</div>
        <div class="item"><div><strong>Approved templates</strong><small>${helo.approved} approved of ${helo.templateCount} total</small></div>
          ${tag(helo.approved > 0, "Ready", "None approved")}</div>` : ""}
    </div>` : `<div class="panel"><h3>WhatsApp connection</h3>
      <div class="item"><div><strong>Provider</strong><small>Bulk sending runs through the Helo API</small></div>
        ${tag(cfg.heloConnected, "Connected", "Not connected")}</div>
    </div>`}
    <div class="panel"><h3>Panel</h3>
      <div class="item"><div><strong>Brand</strong><small>${esc(cfg.brand)}</small></div><span class="tag">live</span></div>
      <div class="item"><div><strong>Mode</strong><small>${cfg.heloConnected ? "Messages are really sent" : "Simulated - no message leaves this machine"}</small></div>
        ${tag(cfg.heloConnected, "Live", "Simulated")}</div>
    </div>
    <div class="panel"><h3>API</h3>
      <p class="empty">Every page in this panel is driven by these endpoints. Call them with
        <code>Authorization: Bearer &lt;your token&gt;</code> from <code>POST /api/auth/login</code>.</p>
      <div class="item"><div><strong>Products</strong><small>GET, POST, PUT, DELETE /api/products</small></div><span class="tag">live</span></div>
      <div class="item"><div><strong>Orders</strong><small>GET, POST /api/orders · PATCH /api/orders/:id</small></div><span class="tag">live</span></div>
      <div class="item"><div><strong>Campaigns</strong><small>GET, POST /api/campaigns</small></div><span class="tag">live</span></div>
      <div class="item"><div><strong>Templates</strong><small>GET /api/templates</small></div><span class="tag">live</span></div>
      <div class="item"><div><strong>Admin</strong><small>GET /api/admin/resellers · POST /api/admin/resellers/:id/credits</small></div><span class="tag">live</span></div>
      <div class="item"><div><strong>Delivery receipts</strong><small>Helo DLR webhooks</small></div><span class="tag">planned</span></div>
    </div>
    <div class="panel"><h3>Coming soon</h3><p class="empty">A public API key, per-user webhooks and a documentation site are not built yet (TODO 3, TODO 5).</p></div>`;
}

async function resellers() {
  const rs = await api("/admin/resellers");
  $("#view").innerHTML = `<div class="panel"><h3>Resellers</h3>
    <p class="empty">Credits are spent 1 per WhatsApp recipient. Add credits here to let a reseller run campaigns.</p>
    ${list(rs, (r) => `<div class="item">
      <div><strong>${esc(r.name)}</strong><small>${esc(r.email)} · code ${esc(r.resellerCode || "-")} · ${r.customers} customers · ${r.campaigns} campaigns</small></div>
      <div class="row-inline"><span class="tag">${r.credits} credits</span><span class="tag">${money(r.revenue)}</span>
        <input class="mini" type="number" id="amt-${r.id}" placeholder="100" min="-999999">
        <button class="btn" data-add="${r.id}">Add</button>
        <button class="btn ghost" data-sub="${r.id}">Remove</button></div></div>`,
    "No resellers yet.")}</div>
    <p id="p-err" class="err"></p>`;
  const grant = async (id, sign) => {
    const raw = $(`#amt-${id}`).value.trim();
    const n = Number(raw);
    if (!Number.isInteger(n) || n === 0) { $("#p-err").textContent = "Enter a whole number first"; return; }
    $("#p-err").textContent = "";
    try { await api("/admin/resellers/" + id + "/credits", "POST", { amount: sign * Math.abs(n) }); resellers(); }
    catch (e) { $("#p-err").textContent = e.message; }
  };
  document.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => grant(b.dataset.add, 1)));
  document.querySelectorAll("[data-sub]").forEach((b) => (b.onclick = () => grant(b.dataset.sub, -1)));
}

async function settings() {
  const isReseller = me.role === "reseller";
  const isBuyer = me.role === "user";
  $("#view").innerHTML = `
    <div class="panel"><h3>Your account</h3>
      <div class="item"><div><strong>${esc(me.name)}</strong><small>${esc(me.email)}</small></div>
        <span class="tag">${isReseller ? "Reseller" : isBuyer ? "Buyer" : "Platform owner"}</span></div>
      ${isBuyer ? `<div class="item"><div><strong>Your reseller</strong><small>You signed up under this reseller</small></div>
        <span class="tag">${esc(me.resellerCode || "-")}</span></div>` : ""}
    </div>
    ${isBuyer ? `<div class="panel"><h3>Your phone number</h3>
      <p class="empty">Your reseller sends WhatsApp campaigns to this number. Include your country code.</p>
      <div class="row"><input id="s-phone" value="${esc(me.phone)}" placeholder="+919876543210"></div>
      <p id="s-perr" class="err"></p><button id="s-psave" class="btn">Save phone</button></div>` : ""}
    ${isReseller ? `<div class="panel"><h3>Your reseller code</h3>
      <p class="empty">Customers type this code on the sign-up form to join you. Changing it only affects new signups — your existing customers stay linked to you.</p>
      <div class="row"><input id="s-code" value="${esc(me.resellerCode)}" placeholder="e.g. ATULYA-TRADE"></div>
      <p id="s-cerr" class="err"></p><button id="s-go" class="btn">Save code</button></div>` : ""}
    ${!isBuyer && !isReseller ? `<div class="panel"><h3>Admin account</h3>
      <p class="empty">This account is created from ADMIN_EMAIL and ADMIN_PASSWORD in .env on first boot. Change the password there to change it here.</p></div>` : ""}`;
  if ($("#s-go")) $("#s-go").onclick = async () => {
    $("#s-cerr").textContent = "";
    try { me = await api("/me/reseller-code", "PATCH", { resellerCode: $("#s-code").value }); settings(); }
    catch (e) { $("#s-cerr").textContent = e.message; }
  };
  if ($("#s-psave")) $("#s-psave").onclick = async () => {
    $("#s-perr").textContent = "";
    try { me = await api("/me", "PATCH", { phone: $("#s-phone").value }); settings(); }
    catch (e) { $("#s-perr").textContent = e.message; }
  };
}
boot();
