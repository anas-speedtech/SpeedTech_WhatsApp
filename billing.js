// Credit pricing, membership plans and the money math behind requests/approvals.
//
// 1 credit = 1 WhatsApp message. Prices are stored in paise (integers) so a campaign of
// N recipients never suffers floating-point rounding: the wipe is always
//   N credits x creditSellPricePaise  ->  amountPaise.
//
// The buy price (what the platform pays) is admin-only. The sell price is what a reseller
// pays. Shared by server.js (runtime defaults + routes) and migrate.js (one-off backfill)
// so the two can never disagree about the shape.

const DEFAULT_BUY_PAISE = 90;   // ₹0.90 per credit
const DEFAULT_SELL_PAISE = 100; // ₹1.00 per credit -> ₹0.10 margin
const SCHEMA_VERSION = 1;       // bump when the one-time backfill below changes

// Membership durations are expressed in months so a plan can be priced independently.
const DEFAULT_PLANS = [
  { name: "Starter", months: 1, pricePaise: 149900 },  // ₹1,499
  { name: "Growth", months: 3, pricePaise: 399900 },   // ₹3,999
  { name: "Scale", months: 12, pricePaise: 1199900 },  // ₹11,999
];

const defaultSettings = () => ({
  creditBuyPricePaise: DEFAULT_BUY_PAISE,
  creditSellPricePaise: DEFAULT_SELL_PAISE,
  requireMembership: true,
});

// ₹0.90 / ₹1,000 / ₹1,000.50 -- drops the decimals only when the value is whole rupees
function paise(n) {
  const v = Number(n || 0) / 100;
  return "₹" + v.toLocaleString("en-IN", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
}
// always two decimals, for a per-credit rate
const perCredit = (p) => `₹${(Number(p || 0) / 100).toFixed(2)}`;

const creditsCost = (credits, pricePaise) => Math.round(Number(credits || 0) * Number(pricePaise || 0));

// A reseller's membership state, derived from the stored expiry. "none" means they never
// bought a plan; both "none" and "expired" block campaign sends when requireMembership is on.
function membershipState(user) {
  if (!user || user.role !== "reseller") return null;
  const expires = user.planExpiresAt ? Date.parse(user.planExpiresAt) : NaN;
  const state = !Number.isFinite(expires) ? "none" : expires < Date.now() ? "expired" : "active";
  return { state, planId: user.planId || null, startedAt: user.planStartedAt || null, expiresAt: user.planExpiresAt || null };
}

const planById = (db, id) => (db.plans || []).find((p) => p.id === Number(id));

// Add `months` to a person's current expiry, or to now if they are not currently covered.
function nextExpiry(fromIso, months) {
  const base = fromIso ? Date.parse(fromIso) : NaN;
  const start = Number.isFinite(base) && base > Date.now() ? new Date(base) : new Date();
  const d = new Date(start);
  d.setMonth(d.getMonth() + Number(months || 1));
  return d.toISOString();
}

function logTxn(db, nextId, t) {
  const row = {
    id: nextId(), at: new Date().toISOString(), type: t.type,
    fromId: t.fromId ?? null, toId: t.toId ?? null,
    credits: Number(t.credits || 0), amountPaise: Number(t.amountPaise || 0),
    costPaise: Number(t.costPaise || 0),
    refType: t.refType || null, refId: t.refId ?? null, note: t.note || "",
  };
  db.txns.push(row);
  return row;
}

// Idempotent. Collections are topped up on every boot; the user field backfill and the
// grandfathering of pre-existing resellers (so the panel keeps working) run once, tracked
// by settings.billingMigrated, so a reseller registered later is never silently comped.
function ensureBilling(db, nextId) {
  let changed = 0;

  if (!db.settings || typeof db.settings !== "object") { db.settings = defaultSettings(); changed++; }
  if (db.settings.creditBuyPricePaise == null) { db.settings.creditBuyPricePaise = DEFAULT_BUY_PAISE; changed++; }
  if (db.settings.creditSellPricePaise == null) { db.settings.creditSellPricePaise = DEFAULT_SELL_PAISE; changed++; }
  if (db.settings.requireMembership == null) { db.settings.requireMembership = true; changed++; }

  if (!Array.isArray(db.plans)) { db.plans = []; changed++; }
  if (!db.plans.length) {
    db.plans = DEFAULT_PLANS.map((p) => ({ id: nextId(), ...p }));
    changed++;
  }
  if (!Array.isArray(db.requests)) { db.requests = []; changed++; }
  if (!Array.isArray(db.txns)) { db.txns = []; changed++; }

  const firstPlan = db.plans[0];
  for (const u of db.users) {
    if (!("active" in u)) { u.active = true; changed++; }
    if (!("billingType" in u)) { u.billingType = "prepaid"; changed++; }
    if (!("onboardedAt" in u)) { u.onboardedAt = new Date().toISOString(); changed++; }
    if (!("lastTxnAt" in u)) { u.lastTxnAt = null; changed++; }
    if (!("wabaId" in u)) { u.wabaId = ""; changed++; }
    if (u.role === "reseller") {
      if (!("planId" in u)) { u.planId = null; changed++; }
      if (!("planStartedAt" in u)) { u.planStartedAt = null; changed++; }
      if (!("planExpiresAt" in u)) { u.planExpiresAt = null; changed++; }
    }
  }

  // one-time: give resellers that predate billing a working membership so nothing that
  // worked before this feature started silently stops sending
  if (db.settings.billingMigrated !== true) {
    const now = new Date().toISOString();
    for (const u of db.users) {
      if (u.role === "reseller" && !u.planExpiresAt) {
        u.planId = firstPlan ? firstPlan.id : null;
        u.planStartedAt = now;
        u.planExpiresAt = nextExpiry(now, firstPlan ? firstPlan.months : 12);
        changed++;
      }
    }
    db.settings.billingMigrated = true;
    changed++;
  }

  db.settings.schemaVersion = SCHEMA_VERSION;
  return changed;
}

module.exports = {
  DEFAULT_BUY_PAISE, DEFAULT_SELL_PAISE, DEFAULT_PLANS, SCHEMA_VERSION,
  defaultSettings, paise, perCredit, creditsCost, membershipState, planById, nextExpiry, logTxn, ensureBilling,
};
