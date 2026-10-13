const $ = (s) => document.querySelector(s);
let token = localStorage.getItem("token"), me = null, cfg = {}, mode = "login";
let editingPlan = null;

async function api(path, method = "GET", body) {
  const isForm = body instanceof FormData;
  const res = await fetch("/api" + path, { method,
    headers: { ...(body && !isForm ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

// ---------- toast ----------
// Small transient confirmation pinned to the corner of the screen. Used after actions
// whose effect is off-screen (e.g. a row appended to a long list) so the click never
// looks like it did nothing.
let toastTimer = null;
function toast(msg, kind = "ok") {
  const host = document.body || document.documentElement;
  if (!host) return;
  let el = host.querySelector ? host.querySelector("#toast") : null;
  if (!el) { el = document.createElement("div"); el.id = "toast"; host.appendChild(el); }
  el.className = "toast " + kind + " show";
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove("show"); }, 2600);
}

// ---------- auth screen ----------
function setMode(m) {
  mode = m;
  $("#auth-title").textContent = m === "login" ? "Sign in" : "Create account";
  $("#a-go").textContent = m === "login" ? "Sign in" : "Create account";
  $("#a-toggle").textContent = m === "login" ? "New here? Create an account" : "Have an account? Sign in";
  document.querySelectorAll(".reg").forEach((e) => e.classList.toggle("hidden", m === "login"));
}
$("#a-toggle").onclick = () => setMode(mode === "login" ? "register" : "login");
$("#a-go").onclick = async () => {
  $("#a-err").textContent = "";
  try {
    const body = { email: $("#a-email").value, password: $("#a-pass").value };
    if (mode === "register") Object.assign(body, { name: $("#a-name").value, signupCode: $("#a-signup").value });
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
// their sub-pages, plus standalone leaves. Clients broadcast to the contacts they keep or
// type in; the platform owner manages clients, payments and pricing.
const NAV = {
  client: [
    { label: "Dashboard", icon: "dashboard", fn: dashboard },
    { label: "Campaigns", icon: "broadcast", fn: campaigns },
    { label: "Contacts", icon: "customers", fn: contacts },
    { label: "Wallet", icon: "wallet", fn: wallet },
    { label: "Templates", icon: "templates", fn: templates },
    { label: "Shortlinks", icon: "shortlinks", fn: coming("Shortlinks", "Tracked links you can drop into a template to measure clicks. Not built yet (TODO 4).") },
    { label: "WhatsApp", icon: "broadcast", fn: clientWhatsapp },
    { label: "Settings", icon: "settings", fn: settings },
    { label: "Developers", icon: "developers", fn: developers },
  ],
  admin: [
    { label: "Dashboard", icon: "dashboard", fn: dashboard },
    { label: "User management", icon: "customers", children: [
      { label: "Management", fn: clients },
      { label: "User wallet", fn: userWallet },
    ] },
    { label: "Payments", icon: "payments", fn: payments },
    { label: "Pricing", icon: "settings", fn: pricing },
    { label: "WhatsApp", icon: "broadcast", fn: adminWhatsapp },
    { label: "Settings", icon: "settings", fn: settings },
  ],
};

const DEFAULT_PAGE = { client: "Dashboard", admin: "Dashboard" };

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
  $("#view").innerHTML = `<div class="splash-inline">${DOTS}</div>`;
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
// The loader is three pulsing dots -- #splash covers first paint, and the same dots are
// swapped into #view by go() while a page's data is still in flight.
const DOTS = '<div class="dots" role="status" aria-label="Loading"><span></span><span></span><span></span></div>';
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
  $("#me-role").textContent = me.role === "admin" ? "Platform owner" : "Client";
  buildNav();
  applySide();
  showCredits(); go(DEFAULT_PAGE[me.role] || navEntries(me.role)[0].label);
}
function showCredits() {
  // only a client holds campaign credits; the platform owner does not
  $("#credits").classList.toggle("hidden", me.role !== "client");
  if (me.role === "client") $("#credits").textContent = `${me.credits} credits`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const list = (items, fn, empty) => items.length ? items.map(fn).join("") : `<p class="empty">${empty}</p>`;
const money = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;
// prices are stored as whole paise so nothing rounds wrong; only the view divides by 100
const rupees = (paise) => `₹${(Number(paise || 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const channelTag = (c) => `<span class="tag ${c === "WhatsApp" ? "whatsapp" : c === "SMS" ? "sms" : "rcs"}">${esc(c)}</span>`;
// lowercased and hyphenated so a status like "In-Draft" maps onto a real css class
const statusTag = (s) => `<span class="tag ${esc(String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-"))}">${esc(s)}</span>`;
const card = (n, label) => `<div class="stat"><b>${n}</b><span>${label}</span></div>`;
// Helo's real template shape is not finalised yet, so read it defensively
const tplName = (t) => esc(t.name || t.templateName || t.template_name || t.id || "(unnamed)");
const tplStatus = (t) => t.status || t.status_name || t.category || t.language || "";

// ---------- dashboards ----------
async function dashboard() {
  if (me.role === "admin") return adminDashboard();
  return clientDashboard();
}
async function adminDashboard() {
  const rs = await api("/admin/clients");
  $("#view").innerHTML = `
    <div class="stats">
      ${card(rs.length, "Clients")}
      ${card(rs.reduce((n, r) => n + r.campaigns, 0), "Campaigns run")}
      ${card(rs.reduce((n, r) => n + r.credits, 0), "Credits held")}
      ${card(rs.reduce((n, r) => n + r.creditsPurchased, 0), "Credits sold")}
    </div>
    <div class="panel"><h3>Client balances</h3>${list(rs, (r) =>
      `<div class="item"><div><strong>${esc(r.name)}</strong><small>${esc(r.email)}</small></div>
        <div class="row-inline"><span class="tag">${r.credits} credits</span><button class="btn" data-go="Management">Manage</button></div></div>`,
      "No clients yet.")}</div>`;
  document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
}

// ---------- client dashboard: stat cards, recent campaigns and contacts ----------
async function clientDashboard() {
  const [stats, cs, book] = await Promise.all([
    api("/client/stats"), api("/campaigns"), api("/client/contacts")]);
  $("#view").innerHTML = `
    <div class="stats">
      ${card(me.credits, "Wallet credits")}
      ${card(stats.creditsUsed, "Credits used")}
      ${card(stats.creditsPurchased + stats.creditsAssigned, "Credits bought")}
      ${card(stats.campaigns, "Campaigns sent")}
      ${card(stats.sent, "Messages sent")}
      ${card(book.length, "Contacts")}
    </div>
    <div class="panel"><h3>Recent campaigns</h3>${list(cs.slice(0, 5), (c) =>
      `<div class="item"><div><strong>${esc(c.name)}</strong><small>${esc(c.templateName)} · ${c.total} recipients · ${new Date(c.at).toLocaleDateString()}</small></div>${statusTag(c.status)}</div>`,
      "No campaigns yet. <button class='link' data-go='Campaigns'>Send your first one</button>.")}</div>
    <div class="panel"><h3>Contacts</h3>${list(book.slice(0, 5), (c) =>
      `<div class="item"><div><strong>${esc(c.name || "Unnamed")}</strong><small>${esc(c.phone)}</small></div></div>`,
      "No contacts yet. <button class='link' data-go='Contacts'>Add your first one</button>.")}</div>`;
  document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
}

// ---------- client: saved contacts (the people a campaign is sent to) ----------
async function contacts() {
  const cs = await api("/client/contacts");
  $("#view").innerHTML = `
    <div class="panel"><h3>Add a contact</h3>
      <div class="row">
        <input id="ct-name" placeholder="Name (optional)">
        <input id="ct-phone" placeholder="Phone with country code, e.g. +919876543210">
      </div>
      <p id="ct-err" class="err"></p>
      <button id="ct-add" class="btn">Add contact</button></div>
    <div class="panel"><h3>Your contacts</h3>${list(cs, (c) => `<div class="item">
      <div><strong>${esc(c.name || "Unnamed")}</strong><small>${esc(c.phone)} · added ${new Date(c.at).toLocaleDateString()}</small></div>
      <button class="btn ghost danger" data-del="${c.id}">Delete</button></div>`,
      "No contacts yet. Add your first one above.")}</div>`;
  $("#ct-add").onclick = async () => {
    $("#ct-err").textContent = "";
    const phone = $("#ct-phone").value.trim();
    if (!phone) { $("#ct-err").textContent = "Enter a phone number."; return; }
    $("#ct-add").disabled = true;
    try {
      await api("/client/contacts", "POST", { name: $("#ct-name").value, phone });
      toast("Contact added");
      contacts();
    } catch (e) { $("#ct-err").textContent = e.message; $("#ct-add").disabled = false; }
  };
  document.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this contact?")) return;
    b.disabled = true;
    try { await api("/client/contacts/" + b.dataset.del, "DELETE"); toast("Contact deleted"); contacts(); }
    catch (e) { toast(e.message, "err"); b.disabled = false; }
  }));
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
  // Templates are the only fetch that depends on Helo being up. If the provider is
  // unreachable this must not reject, or Promise.all would replace the whole view with a
  // raw "Helo unreachable" error and the campaign list would be unusable.
  const [cs, book, heloErr, rawTs, rawCustom] = await Promise.all([
    api("/campaigns"), api("/client/contacts"),
    api("/templates").then(() => null, (e) => e.message),
    api("/templates/custom").catch(() => []),
  ]);
  const ts = [...(rawCustom || []), ...(rawTs || [])];
  // Helo only accepts APPROVED templates, and needs the category + language with the name.
  // Hand-entered templates are treated as ready, so a campaign can still be built offline.
  const usable = ts.filter((t) => t.custom || tplStatus(t) === "APPROVED" || tplStatus(t) === "SIMULATED");
  const tplLabel = (t) => [tplName(t), tplStatus(t), t.category, t.language].filter(Boolean).join(" · ");
  $("#view").innerHTML = `
    <div class="panel"><h3>New campaign</h3>
      ${heloErr ? `<p class="empty">Could not reach Helo to load templates — ${esc(heloErr)}. Campaigns below still show; add a template by hand on the Templates page to keep going.</p>`
        : cfg.heloConnected ? "" : "<p class='empty'>Helo API not connected yet — campaigns are simulated.</p>"}
      ${!usable.length ? `<p class="empty">No templates available. Get one approved in Helo, or add your own on the Templates page.</p>` : ""}
      <div class="row"><input id="c-name" placeholder="Campaign name">
        <select id="c-tpl">${usable.map((t, i) => `<option value="${i}">${esc(tplLabel(t))}</option>`).join("")}</select></div>
      <div class="row">
        <input id="c-v1" placeholder="Body variable 1 (optional, same for everyone)">
        <input id="c-v2" placeholder="Body variable 2 (optional)"></div>
      <p class="empty">Leave the variable boxes empty unless the template body has {{1}}-style placeholders.</p>
      <div class="pick">
        <div class="pick-head"><strong>Saved contacts</strong>
          <span><b id="c-count">0</b> recipient(s) · needs <b id="c-cost">0</b> credits (you have ${me.credits})</span>
          <button id="c-all" class="link">Select all</button></div>
        ${book.length ? book.map((u) => `<label class="pick-row">
          <input type="checkbox" value="${u.id}"><span>${esc(u.name || "Unnamed")}</span><small>${esc(u.phone)}</small></label>`).join("")
          : `<p class="empty">No saved contacts yet — <button class='link' data-go='Contacts'>add one</button>, or just type numbers below.</p>`}
      </div>
      <p class="empty" style="margin-top:14px"><strong>Or type numbers</strong> — one per line or comma-separated. Numbers already picked above are not sent twice.</p>
      <textarea id="c-numbers" rows="3" placeholder="+919876543210, +919812345678"></textarea>
      <p id="c-err" class="err"></p><button id="c-go" class="btn"${usable.length ? "" : " disabled"}>Send campaign</button></div>
    ${campaignsListMarkup(cs)}`;
  document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
  const boxes = [...document.querySelectorAll(".pick-row input")];
  const typed = () => $("#c-numbers").value.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  const chosen = () => boxes.filter((b) => b.checked).map((b) => +b.value);
  const recount = () => { const n = chosen().length + typed().length; $("#c-count").textContent = n; $("#c-cost").textContent = n; };
  boxes.forEach((b) => (b.onchange = recount));
  $("#c-numbers").oninput = recount;
  $("#c-all").onclick = () => { const on = boxes.some((b) => !b.checked); boxes.forEach((b) => (b.checked = on)); recount(); };
  $("#c-go").onclick = async () => {
    $("#c-err").textContent = "";
    const t = usable[+$("#c-tpl").value] || usable[0];
    if (!t) { $("#c-err").textContent = "No approved template to send"; return; }
    const vars = [$("#c-v1").value.trim(), $("#c-v2").value.trim()].filter(Boolean);
    const numbers = typed();
    if (!chosen().length && !numbers.length) { $("#c-err").textContent = "Pick a contact or type at least one number."; return; }
    // keyed by the digits Helo expects, matching how sendBulkTemplate looks them up
    const params = {};
    if (vars.length) {
      for (const u of book) if (chosen().includes(u.id)) params[u.phone.replace(/\D/g, "")] = vars;
      for (const n of numbers) params[n.replace(/\D/g, "")] = vars;
    }
    try {
      const r = await api("/campaigns", "POST", { name: $("#c-name").value,
        templateName: tplName(t), templateCategory: t.category || "", templateLanguage: t.language || "en",
        contactIds: chosen(), numbers, params });
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
  $("#view").innerHTML = `
    <div class="panel"><h3>Your templates</h3>
      <div id="t-helo"><p class="empty">Loading Helo templates…</p></div></div>
    <div class="panel"><h3>Add your own</h3>
      <p class="empty">Type in a template that already exists in Helo (name and language must match). It shows up in the campaign builder straight away, even while the Helo template list is unreachable.</p>
      <div class="row">
        <input id="t-name" placeholder="Template name, e.g. ismotors_client">
        <select id="t-cat"><option>MARKETING</option><option>UTILITY</option><option>AUTHENTICATION</option></select>
        <input id="t-lang" placeholder="Language" value="en"></div>
      <p id="t-err" class="err"></p>
      <button id="t-add" class="btn">Add template</button></div>
    <div class="panel"><h3>Your added templates</h3>
      <div id="t-custom"><p class="empty">Loading…</p></div></div>`;
  $("#t-add").onclick = async () => {
    $("#t-err").textContent = "";
    const name = $("#t-name").value.trim();
    if (!name) { $("#t-err").textContent = "Give the template a name."; return; }
    const btn = $("#t-add");
    btn.disabled = true;
    try {
      await api("/templates/custom", "POST", { name, category: $("#t-cat").value, language: $("#t-lang").value });
      $("#t-name").value = "";
      toast(`Template "${name}" added`);
      await loadCustom();
    } catch (e) { $("#t-err").textContent = e.message; toast(e.message, "err"); }
    finally { btn.disabled = false; }
  };
  // The Helo list can hang for many seconds when the host is unreachable, so each panel
  // loads on its own. Adding or deleting a custom template never waits on Helo.
  loadCustom();
  loadHelo();
}

async function loadCustom() {
  const box = $("#t-custom");
  if (!box) return;
  try {
    const items = await api("/templates/custom");
    const rows = items.slice().sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    box.innerHTML = list(rows, (t) => `<div class="item"><div><strong>${tplName(t)}</strong>
      <small>${esc(t.category)} · ${esc(t.language)}</small></div>
      <button class="btn ghost" data-del="${t.id}">Delete</button></div>`, "None added yet.");
    box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
      const t = items.find((x) => String(x.id) === String(b.dataset.del));
      b.disabled = true;
      try {
        await api("/templates/custom/" + b.dataset.del, "DELETE");
        toast(`Template "${t ? tplName(t) : "template"}" deleted`);
        await loadCustom();
      } catch (e) { toast(e.message, "err"); b.disabled = false; }
    }));
  } catch (e) { box.innerHTML = `<p class="empty err">${esc(e.message)}</p>`; }
}

async function loadHelo() {
  const box = $("#t-helo");
  if (!box) return;
  try {
    const ts = await api("/templates");
    box.innerHTML = list(ts, (t) => `<div class="item"><div><strong>${tplName(t)}</strong>
      <small>${esc(tplStatus(t) || "Approved")}</small></div>
      <span class="tag">${esc(tplStatus(t) || "ready")}</span></div>`, "No templates available.");
  } catch (e) {
    box.innerHTML = `<p class="empty">Could not reach Helo to load templates — ${esc(e.message)}.</p>
      <p class="empty">Add your own below; it appears in the campaign builder right away.</p>`;
  }
}

async function developers() {
  // the health check is admin-only, so clients get the simple configured/not view
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
      <div class="item"><div><strong>Contacts</strong><small>GET, POST, PUT, DELETE /api/client/contacts</small></div><span class="tag">live</span></div>
      <div class="item"><div><strong>Campaigns</strong><small>GET, POST /api/campaigns</small></div><span class="tag">live</span></div>
      <div class="item"><div><strong>Templates</strong><small>GET /api/templates · GET, POST, DELETE /api/templates/custom</small></div><span class="tag">live</span></div>
      <div class="item"><div><strong>Admin</strong><small>GET /api/admin/clients · POST /api/admin/clients/:id/credits · GET /api/admin/clients/:id/wallet</small></div><span class="tag">live</span></div>
      <div class="item"><div><strong>Client templates (admin)</strong><small>GET, POST, DELETE /api/admin/templates</small></div><span class="tag">live</span></div>
      <div class="item"><div><strong>Delivery receipts</strong><small>Helo DLR webhooks</small></div><span class="tag">planned</span></div>
    </div>
    <div class="panel"><h3>Coming soon</h3><p class="empty">A public API key, per-user webhooks and a documentation site are not built yet (TODO 3, TODO 5).</p></div>`;
}

async function clients() {
  const rs = await api("/admin/clients");
  const mTag = (m) => m && m.state === "active" ? `<span class="tag fulfilled">Active</span>`
    : m && m.state === "expired" ? `<span class="tag cancelled">Expired</span>` : `<span class="tag none">No plan</span>`;
  $("#view").innerHTML = `<div class="panel"><h3>Clients</h3>
    <p class="empty">Credits are spent 1 per WhatsApp recipient. Approve purchases from the Payments page, or grant credits here directly.</p>
    <div class="row"><input id="r-q" placeholder="Search name, email or phone"><select id="r-status"><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select></div>
    <div id="r-list"></div>
    <p id="p-err" class="err"></p></div>`;
  const draw = () => {
    const q = $("#r-q").value.trim().toLowerCase();
    const st = $("#r-status").value;
    const byStatus = (r) => st === "active" ? r.active !== false : st === "inactive" ? r.active === false : true;
    const shown = rs.filter((r) => byStatus(r) && (!q || [r.name, r.email, r.phone].join(" ").toLowerCase().includes(q)));
    $("#r-list").innerHTML = list(shown, (r) => `<div class="item">
      <div><strong>${esc(r.name)}</strong><small>${esc(r.email)}${r.phone ? " · " + esc(r.phone) : " · no sender number"} · ${r.contacts} contacts · ${r.campaigns} campaigns</small>
        <small>${r.creditsPurchased} bought · ${r.creditsAssigned} granted · ${r.creditsUsed} used</small></div>
      <div class="row-inline">
        <span class="tag">${r.credits} credits</span>
        ${mTag(r.membership)}
        <span class="tag">${rupees(r.revenuePaise)}</span>
        <input class="mini" type="number" id="amt-${r.id}" placeholder="100" min="-999999">
        <button class="btn" data-add="${r.id}">Add</button>
        <button class="btn ghost" data-sub="${r.id}">Remove</button></div></div>`, "No clients match.");
    document.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => grant(b.dataset.add, 1)));
    document.querySelectorAll("[data-sub]").forEach((b) => (b.onclick = () => grant(b.dataset.sub, -1)));
  };
  const grant = async (id, sign) => {
    const raw = $(`#amt-${id}`).value.trim();
    const n = Number(raw);
    if (!Number.isInteger(n) || n === 0) { $("#p-err").textContent = "Enter a whole number first"; return; }
    $("#p-err").textContent = "";
    try { await api("/admin/clients/" + id + "/credits", "POST", { amount: sign * Math.abs(n) }); clients(); }
    catch (e) { $("#p-err").textContent = e.message; }
  };
  $("#r-q").oninput = draw;
  $("#r-status").onchange = draw;
  draw();
}

// ---------- admin: one client's wallet on a single screen ----------
async function userWallet() {
  const rs = await api("/admin/clients");
  $("#view").innerHTML = `<div class="panel"><h3>User wallet</h3>
    <p class="empty">Pick a client to see their balance, credit ledger and payment history, and to top up or remove credits.</p>
    <div class="row"><select id="uw-client">${rs.length ? rs.map((r) => `<option value="${r.id}">${esc(r.name)} — ${esc(r.email)}</option>`).join("") : `<option value="">No clients yet</option>`}</select></div>
    <div id="uw-body"></div>
    <p id="p-err" class="err"></p></div>`;
  const load = async () => {
    const id = $("#uw-client").value || (rs[0] && String(rs[0].id));
    const box = $("#uw-body");
    if (!id) { box.innerHTML = `<p class="empty">No clients yet.</p>`; return; }
    box.innerHTML = `<div class="splash-inline">${DOTS}</div>`;
    const w = await api("/admin/clients/" + id + "/wallet");
    const m = w.summary.membership || { state: "none" };
    const mTag = m.state === "active" ? `<span class="tag fulfilled">Active until ${new Date(m.expiresAt).toLocaleDateString()}</span>`
      : m.state === "expired" ? `<span class="tag cancelled">Expired</span>` : `<span class="tag none">No plan</span>`;
    const signed = (t) => (t.toId === w.client.id ? "+" + t.credits : "-" + t.credits);
    box.innerHTML = `
      <div class="stats">
        ${card(w.client.credits, "Credit balance")}
        ${card(w.summary.creditsPurchased, "Credits bought")}
        ${card(w.summary.creditsAssigned, "Credits granted")}
        ${card(w.summary.creditsUsed, "Credits used")}
      </div>
      <div class="item"><div><strong>${esc(w.client.name)}</strong><small>${esc(w.client.email)}${w.client.phone ? " · " + esc(w.client.phone) : " · no sender number"}</small></div>${mTag}</div>
      <div class="row"><input class="mini" id="uw-amt" type="number" placeholder="100" min="-999999">
        <button class="btn" id="uw-add">Add credits</button>
        <button class="btn ghost" id="uw-sub">Remove credits</button></div>
      <div class="panel"><h3>Credit ledger</h3>${list(w.txns, (t) => `<div class="item">
        <div><strong>${esc(t.note || t.type)}</strong><small>${new Date(t.at).toLocaleString()} · ${esc(t.type)}</small></div>
        <span class="tag ${t.credits > 0 ? "fulfilled" : "none"}">${signed(t)} credits</span></div>`, "Nothing yet.")}</div>
      <div class="panel"><h3>Payment history</h3>${list(w.requests, (r) => `<div class="item">
        <div><strong>${r.kind === "credits" ? r.credits + " credits" : (r.plan ? esc(r.plan.name) + " membership" : "Membership")}</strong>
          <small>${new Date(r.at).toLocaleString()} · ${rupees(r.amountPaise)}${r.method ? " · " + esc(r.method) : ""}</small></div>
        ${statusTag(r.status)}</div>`, "Nothing yet.")}</div>`;
    const grant = async (sign) => {
      const n = Number($("#uw-amt").value.trim());
      if (!Number.isInteger(n) || n === 0) { $("#p-err").textContent = "Enter a whole number first"; return; }
      $("#p-err").textContent = "";
      try { await api("/admin/clients/" + id + "/credits", "POST", { amount: sign * Math.abs(n) }); load(); }
      catch (e) { $("#p-err").textContent = e.message; }
    };
    $("#uw-add").onclick = () => grant(1);
    $("#uw-sub").onclick = () => grant(-1);
  };
  $("#uw-client").onchange = load;
  if (rs.length) await load();
  else $("#uw-body").innerHTML = `<p class="empty">No clients yet.</p>`;
}

// ---------- admin: manage WhatsApp across every client ----------
async function adminWhatsapp() {
  const [rs, tpls, helo] = await Promise.all([
    api("/admin/clients"),
    api("/admin/templates"),
    api("/helo/status").catch((e) => ({ ok: false, reason: e.message })),
  ]);
  const tag = (ok, yes, no) => `<span class="tag ${ok ? "fulfilled" : "cancelled"}">${ok ? yes : no}</span>`;
  const ownerName = (t) => t.owner || (rs.find((r) => r.id === t.ownerId) || {}).name || "Client";
  $("#view").innerHTML = `
    <div class="panel"><h3>WhatsApp connection</h3>
      <div class="item"><div><strong>Provider</strong><small>${esc(helo.baseUrl || "Helo API")}</small></div>${tag(helo.ok, "Working", "Not working")}</div>
      <div class="item"><div><strong>Credentials</strong><small>${esc(helo.reason || helo.error || "signed in and reachable")}</small></div>${tag(helo.ok, "OK", "Check .env")}</div>
      ${helo.ok ? `<div class="item"><div><strong>Approved templates</strong><small>${helo.approved} approved of ${helo.templateCount} total</small></div>${tag(helo.approved > 0, "Ready", "None approved")}</div>` : ""}
    </div>
    <div class="panel"><h3>Client sender numbers</h3>
      <p class="empty">Each client sends campaigns from their own connected WhatsApp number. Fix one here if a client cannot set it themselves.</p>
      ${list(rs, (r) => `<div class="item"><div><strong>${esc(r.name)}</strong><small>${esc(r.email)} · ${r.templates} template(s)</small></div>
        <div class="row-inline"><input class="mini" id="wa-${r.id}" value="${esc(r.phone || "")}" placeholder="+919876543210">
        <button class="btn" data-wa="${r.id}">Save number</button></div></div>`, "No clients yet.")}</div>
    <div class="panel"><h3>Add a template for a client</h3>
      <div class="row"><select id="aw-client">${rs.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")}</select>
        <input id="aw-name" placeholder="Template name, e.g. ismotors_client">
        <select id="aw-cat"><option>MARKETING</option><option>UTILITY</option><option>AUTHENTICATION</option></select>
        <input id="aw-lang" placeholder="Language" value="en"></div>
      <p id="aw-err" class="err"></p><button id="aw-add" class="btn">Add template</button></div>
    <div class="panel"><h3>Client templates</h3>${list(tpls, (t) => `<div class="item"><div><strong>${tplName(t)}</strong>
      <small>${esc(ownerName(t))} · ${esc(t.category)} · ${esc(t.language)}</small></div>
      <button class="btn ghost danger" data-atdel="${t.id}">Delete</button></div>`, "No client templates yet.")}</div>
    <p id="p-err" class="err"></p>`;
  document.querySelectorAll("[data-wa]").forEach((b) => (b.onclick = async () => {
    try { await api("/admin/clients/" + b.dataset.wa, "PATCH", { phone: $("#wa-" + b.dataset.wa).value.trim() }); toast("Sender number saved"); adminWhatsapp(); }
    catch (e) { $("#p-err").textContent = e.message; }
  }));
  $("#aw-add").onclick = async () => {
    $("#aw-err").textContent = "";
    const name = $("#aw-name").value.trim();
    if (!name) { $("#aw-err").textContent = "Give the template a name."; return; }
    try {
      await api("/admin/templates", "POST", { ownerId: +$("#aw-client").value, name, category: $("#aw-cat").value, language: $("#aw-lang").value });
      toast("Template added"); adminWhatsapp();
    } catch (e) { $("#aw-err").textContent = e.message; }
  };
  document.querySelectorAll("[data-atdel]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this template?")) return;
    try { await api("/admin/templates/" + b.dataset.atdel, "DELETE"); toast("Template deleted"); adminWhatsapp(); }
    catch (e) { $("#p-err").textContent = e.message; }
  }));
}

// ---------- client: connect the WhatsApp number campaigns are sent from ----------
async function clientWhatsapp() {
  const connected = Boolean((me.phone || "").trim());
  $("#view").innerHTML = `
    <div class="panel"><h3>Connect your WhatsApp</h3>
      <p class="empty">Campaigns are sent from this WhatsApp number. Enter it with the country code and save — every campaign then goes out from it. Leave it empty to fall back to the platform's default sender.</p>
      <div class="item"><div><strong>Status</strong><small>${connected ? "Connected as " + esc(me.phone) : "Not connected yet"}</small></div>
        ${connected ? '<span class="tag fulfilled">Connected</span>' : '<span class="tag cancelled">Not connected</span>'}</div>
      <div class="row"><input id="wa-phone" value="${esc(me.phone || "")}" placeholder="+919876543210">
        <button id="wa-save" class="btn">Save &amp; connect</button></div>
      <p id="wa-err" class="err"></p></div>
    <div class="panel"><h3>Provider</h3>
      <div class="item"><div><strong>${esc(cfg.brand)} WhatsApp API</strong><small>Bulk sending runs through Helo.</small></div>
        <span class="tag ${cfg.heloConnected ? "fulfilled" : "cancelled"}">${cfg.heloConnected ? "Connected" : "Not connected"}</span></div>
      <p class="empty">Templates live on the <button class='link' data-go='Templates'>Templates</button> page.</p></div>`;
  document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
  $("#wa-save").onclick = async () => {
    $("#wa-err").textContent = "";
    const btn = $("#wa-save");
    btn.disabled = true;
    try { me = await api("/me", "PATCH", { phone: $("#wa-phone").value.trim() }); toast("Sender number saved"); showCredits(); clientWhatsapp(); }
    catch (e) { $("#wa-err").textContent = e.message; btn.disabled = false; }
  };
}

// ---------- client wallet: buy credits, renew membership, see the ledger ----------
async function wallet() {
  const [pricing, reqs, txns] = await Promise.all([api("/pricing"), api("/client/requests"), api("/client/txns")]);
  const m = me.membership || { state: "none" };
  const plan = pricing.plans.find((p) => p.id === m.planId);
  const sell = pricing.creditSellPricePaise;
  const daysLeft = m.state === "active" ? Math.max(0, Math.ceil((Date.parse(m.expiresAt) - Date.now()) / 86400000)) : 0;
  const mTag = m.state === "active" ? `<span class="tag fulfilled">Active until ${new Date(m.expiresAt).toLocaleDateString()}</span>`
    : m.state === "expired" ? `<span class="tag cancelled">Expired</span>` : `<span class="tag none">No plan</span>`;
  const signed = (t) => t.toId === me.id ? `+${t.credits}` : `-${t.credits}`;
  $("#view").innerHTML = `
    <div class="stats">
      ${card(me.credits, "Credit balance")}
      ${card(rupees(sell), "Price per credit")}
      ${card(rupees(me.credits * sell), "Balance value")}
      ${card(daysLeft, "Membership days left")}
    </div>
    <div class="panel"><h3>Your membership</h3>
      <div class="item"><div><strong>${plan ? esc(plan.name) : "No plan selected"}</strong>
        <small>An active membership is required before a campaign can be sent.</small></div>${mTag}</div>
    </div>
    <div class="panel"><h3>Buy credits</h3>
      <p class="empty">1 credit = 1 WhatsApp message. Pay by UPI and your balance is credited instantly.</p>
      <div class="calc">
        <label>Credits <input id="w-qty" type="number" min="1" step="1" value="1000"></label>
        <div class="calc-out"><small>You pay</small><b id="w-cost">${rupees(1000 * sell)}</b></div>
      </div>
      <p id="w-err" class="err"></p>
      <button id="w-buy" class="btn">Buy credits</button>
    </div>
    <div class="panel"><h3>Membership plans</h3>
      ${list(pricing.plans, (p) => `<div class="item"><div><strong>${esc(p.name)}</strong><small>${p.months} month${p.months > 1 ? "s" : ""}</small></div>
        <div class="row-inline"><span class="tag">${rupees(p.pricePaise)}</span>
        <button class="btn ghost" data-plan="${p.id}">Buy</button></div></div>`,
      "No plans available yet.")}
    </div>
    <div class="panel"><h3>Payment history</h3>${list(reqs, (r) => `<div class="item">
      <div><strong>${r.kind === "credits" ? r.credits + " credits" : (r.plan ? esc(r.plan.name) + " membership" : "Membership")}</strong>
        <small>${new Date(r.at).toLocaleString()} · ${rupees(r.amountPaise)}${r.method ? " · " + esc(r.method) : ""}${r.note ? " · " + esc(r.note) : ""}</small>
        ${r.decisionNote ? `<small>${esc(r.decisionNote)}</small>` : ""}</div>
      ${statusTag(r.status)}</div>`, "Nothing yet.")}</div>
    <div class="panel"><h3>Credit ledger</h3>${list(txns, (t) => `<div class="item">
      <div><strong>${esc(t.note || t.type)}</strong><small>${new Date(t.at).toLocaleString()} · ${esc(t.type)}</small></div>
      <span class="tag ${t.credits > 0 ? "fulfilled" : "none"}">${signed(t)} credits</span></div>`, "Nothing yet.")}</div>`;
  const qty = () => Math.max(1, Math.floor(Number($("#w-qty").value) || 0));
  $("#w-qty").oninput = () => { $("#w-cost").textContent = rupees(qty() * sell); };
  $("#w-buy").onclick = () => openCheckout("credits", { credits: qty() });
  document.querySelectorAll("[data-plan]").forEach((b) => (b.onclick = () => openCheckout("membership", { planId: +b.dataset.plan })));
}

// ---------- UPI checkout: quote, scan/pay, confirm -> instant credit ----------
function closeModal() { const m = $("#modal"); m.innerHTML = ""; m.classList.add("hidden"); }
async function openCheckout(kind, payload) {
  const m = $("#modal");
  m.classList.remove("hidden");
  m.innerHTML = `<div class="modal-card"><div class="modal-load">${DOTS}</div></div>`;
  let q;
  try { q = await api("/client/checkout/quote", "POST", { kind, ...payload }); }
  catch (e) {
    m.innerHTML = `<div class="modal-card"><h3>Checkout</h3><p class="err">${esc(e.message)}</p>
      <button class="btn ghost" data-x>Close</button></div>`;
    m.querySelectorAll("[data-x]").forEach((b) => (b.onclick = closeModal));
    return;
  }
  const p = q.payment;
  m.innerHTML = `<div class="modal-card">
    <div class="modal-head"><h3>Pay by UPI</h3><button class="icon-btn" data-x aria-label="Close">&times;</button></div>
    <p class="empty">${esc(q.label)} · you pay <b>${rupees(q.amountPaise)}</b></p>
    ${p.configured ? `
      ${p.qr ? `<div class="qr"><img src="${esc(p.qr)}" alt="UPI QR code" width="220" height="220"></div>` : ""}
      <p class="empty">Scan with any UPI app, or pay to <b>${esc(p.vpa)}</b> (${esc(p.payeeName)}).</p>
      ${p.uri ? `<p class="row"><a class="btn" href="${esc(p.uri)}" rel="noopener">Open UPI app</a></p>` : ""}`
    : `<p class="empty">UPI is not configured on this panel yet — set <code>UPI_VPA</code> in <code>.env</code>. The purchase below will still be recorded.</p>`}
    <label class="check"><input id="co-ref" placeholder="UPI reference / UTR (optional)"></label>
    <p id="co-err" class="err"></p>
    <div class="row"><button id="co-pay" class="btn">I've paid · activate ${esc(q.kind === "credits" ? q.credits + " credits" : "membership")}</button>
      <button class="btn ghost" data-x>Cancel</button></div>
  </div>`;
  m.querySelectorAll("[data-x]").forEach((b) => (b.onclick = closeModal));
  $("#co-pay").onclick = async () => {
    $("#co-err").textContent = "";
    $("#co-pay").disabled = true;
    try {
      await api("/client/checkout/pay", "POST", { kind, ...payload, ref: $("#co-ref").value.trim() });
      closeModal();
      me = await api("/me"); showCredits(); wallet();
    } catch (e) { $("#co-err").textContent = e.message; $("#co-pay").disabled = false; }
  };
}

// ---------- admin: approve credit and membership requests ----------
let payFilter = "pending";
async function payments() {
  const decide = async (rid, action) => {
    $("#p-err").textContent = "";
    try { await api(`/admin/requests/${rid}/${action}`, "POST", {}); payments(); }
    catch (e) { $("#p-err").textContent = e.message; }
  };
  const reqs = await api("/admin/requests");
  const shown = payFilter ? reqs.filter((r) => r.status === payFilter) : reqs;
  $("#view").innerHTML = `<div class="panel"><h3>Payment &amp; membership requests</h3>
    <div class="tabs">${[["pending", "Pending"], ["approved", "Approved"], ["rejected", "Rejected"], ["", "All"]].map(([v, l]) =>
      `<button class="tab${payFilter === v ? " on" : ""}" data-f="${v}">${l}</button>`).join("")}</div>
    ${list(shown, (r) => `<div class="item">
      <div><strong>${esc(r.client ? r.client.name : "Client")}</strong>
        <small>${r.kind === "credits" ? r.credits + " credits" : (r.plan ? esc(r.plan.name) + " membership" : "Membership")} · ${rupees(r.amountPaise)} · ${new Date(r.at).toLocaleString()}</small>
        <small>${esc(r.client ? r.client.email : "")}${r.method ? " · " + esc(r.method) : ""}${r.note ? " · " + esc(r.note) : ""}</small></div>
      <div class="row-inline">${statusTag(r.status)}
        ${r.status === "pending" ? `<button class="btn" data-ok="${r.id}">Approve</button><button class="btn ghost danger" data-no="${r.id}">Reject</button>` : ""}</div></div>`,
    "Nothing here.")}</div><p id="p-err" class="err"></p>`;
  document.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { payFilter = b.dataset.f; payments(); }));
  document.querySelectorAll("[data-ok]").forEach((b) => (b.onclick = () => decide(b.dataset.ok, "approve")));
  document.querySelectorAll("[data-no]").forEach((b) => (b.onclick = () => decide(b.dataset.no, "reject")));
}

// ---------- admin: credit pricing and membership plans ----------
async function pricing() {
  const s = await api("/admin/settings");
  const editing = editingPlan;
  $("#view").innerHTML = `
    <div class="panel"><h3>Credit pricing</h3>
      <p class="empty">The buy price is what the platform pays per credit; the sell price is what a client pays. Both are held in paise so a large campaign never rounds wrong.</p>
      <div class="row">
        <label>Buy price (₹ / credit)<input id="pr-buy" type="number" min="0.01" step="0.01" value="${(s.creditBuyPricePaise / 100).toFixed(2)}"></label>
        <label>Sell price (₹ / credit)<input id="pr-sell" type="number" min="0.01" step="0.01" value="${(s.creditSellPricePaise / 100).toFixed(2)}"></label>
      </div>
      <label class="check"><input id="pr-req" type="checkbox"${s.requireMembership ? " checked" : ""}> Require an active membership before a client can send</label>
      <p class="empty">Margin: ${rupees(s.creditSellPricePaise - s.creditBuyPricePaise)} per credit.</p>
      <p id="pr-err" class="err"></p>
      <button id="pr-save" class="btn">Save pricing</button>
    </div>
    <div class="panel"><h3>${editing ? "Edit plan" : "Add a plan"}</h3>
      <div class="row">
        <input id="pl-name" placeholder="Plan name" value="${editing ? esc(editing.name) : ""}">
        <input id="pl-months" type="number" min="1" step="1" placeholder="Months" value="${editing ? editing.months : ""}">
        <input id="pl-price" type="number" min="1" step="1" placeholder="Price (₹)" value="${editing ? (editing.pricePaise / 100) : ""}">
      </div>
      <p id="pl-err" class="err"></p>
      <div class="row"><button id="pl-add" class="btn">${editing ? "Save plan" : "Add plan"}</button>
        ${editing ? `<button id="pl-cancel" class="btn ghost">Cancel</button>` : ""}</div>
    </div>
    <div class="panel"><h3>Plans</h3>${list(s.plans, (p) => `<div class="item"><div><strong>${esc(p.name)}</strong><small>${p.months} month${p.months > 1 ? "s" : ""}</small></div>
      <div class="row-inline"><span class="tag">${rupees(p.pricePaise)}</span>
        <button class="btn ghost" data-pedit="${p.id}">Edit</button>
        <button class="btn ghost danger" data-pdel="${p.id}">Delete</button></div></div>`, "No plans yet.")}</div>`;
  $("#pr-save").onclick = async () => {
    $("#pr-err").textContent = "";
    try {
      await api("/admin/settings", "PATCH", { creditBuyPricePaise: Math.round(Number($("#pr-buy").value) * 100),
        creditSellPricePaise: Math.round(Number($("#pr-sell").value) * 100), requireMembership: $("#pr-req").checked });
      pricing();
    } catch (e) { $("#pr-err").textContent = e.message; }
  };
  $("#pl-add").onclick = async () => {
    $("#pl-err").textContent = "";
    const body = { name: $("#pl-name").value.trim(), months: Number($("#pl-months").value), pricePaise: Math.round(Number($("#pl-price").value) * 100) };
    try {
      if (editing) await api("/admin/plans/" + editing.id, "PUT", body);
      else await api("/admin/plans", "POST", body);
      editingPlan = null; pricing();
    } catch (e) { $("#pl-err").textContent = e.message; }
  };
  if ($("#pl-cancel")) $("#pl-cancel").onclick = () => { editingPlan = null; pricing(); };
  document.querySelectorAll("[data-pedit]").forEach((b) => (b.onclick = () => { editingPlan = s.plans.find((p) => p.id === +b.dataset.pedit); pricing(); }));
  document.querySelectorAll("[data-pdel]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this plan?")) return;
    try { await api("/admin/plans/" + b.dataset.pdel, "DELETE"); pricing(); }
    catch (e) { $("#pl-err").textContent = e.message; }
  }));
}

async function settings() {
  const isClient = me.role === "client";
  const m = me.membership || { state: "none" };
  const mLabel = m.state === "active" ? `Active until ${new Date(m.expiresAt).toLocaleDateString()}`
    : m.state === "expired" ? "Expired" : "No plan yet";
  $("#view").innerHTML = `
    <div class="panel"><h3>Your account</h3>
      <div class="item"><div><strong>${esc(me.name)}</strong><small>${esc(me.email)}</small></div>
        <span class="tag">${isClient ? "Client" : "Platform owner"}</span></div>
    </div>
    ${isClient ? `<div class="panel"><h3>WhatsApp</h3>
      <div class="item"><div><strong>${me.phone ? esc(me.phone) : "No sender number connected"}</strong>
        <small>Campaigns go out from this number.</small></div>
        <button class="btn" data-go="WhatsApp">Manage</button></div></div>
    <div class="panel"><h3>Your membership</h3>
      <div class="item"><div><strong>${mLabel}</strong>
        <small>An active membership is required before a campaign can be sent.</small></div>
        <button class="btn" data-go="Wallet">Go to wallet</button></div></div>`
    : `<div class="panel"><h3>Admin account</h3>
      <p class="empty">This account is created from ADMIN_EMAIL and ADMIN_PASSWORD in .env on first boot. Change the password there to change it here.</p></div>`}`;
  document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
}
boot();
