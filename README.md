# Reseller WhatsApp Panel

Node + Express backend, plain HTML/JS frontend, JSON-file database. Needs Node 18+.

## The model

Three roles, and the direction of everything is *downhill*:

- **admin** — the platform owner. Lists every reseller, grants or removes campaign credits,
  watches every order. No catalogue and no campaigns of their own.
- **reseller** — holds campaign credits, publishes a product catalogue, and fulfils incoming
  orders. Campaign recipients are the buyers who signed up with their code.
- **user** — a buyer. Browses the products of the reseller whose code they signed up with and
  places orders. Buyers have no campaign UI and no usable credits.

Credits are spent **1 per WhatsApp recipient** and are deducted server-side. A reseller can only
target buyers linked to their own `resellerId`; the request sends user IDs, the server resolves
them to phone numbers.

## Run

1. `npm install`
2. Copy `.env.example` to `.env` and set `BRAND_NAME`, `JWT_SECRET`, `ADMIN_EMAIL`,
   `ADMIN_PASSWORD`, `RESELLER_SIGNUP_CODE`
3. `npm run dev` then open http://localhost:3000
4. The admin account is seeded from `.env` on first boot and can sign in straight away
5. Sign up a reseller with `RESELLER_SIGNUP_CODE`, then sign up a buyer with the reseller's code
6. As admin, grant the reseller credits -> the reseller adds products and campaigns to their buyers

## Sidebar

The navigation mirrors Helo Broadcast (https://broadcastbeta.helo.ai): a handful of top-level
sections that slide open to reveal their sub-pages, each with a 20x20 icon, plus standalone leaves.
Which sections are open is remembered in `localStorage` per role, and the whole sidebar collapses
to an icon-only rail from the button in the page header.

| Role | Sections and pages |
| --- | --- |
| Reseller | **Broadcast** (Campaigns, Governance), **Analyse** (Dashboard, Reports), **Store** (Products, Customers), Orders, Templates, Shortlinks, Settings, Developers |
| Buyer | Dashboard, **Store** (Products), Orders, Templates, Shortlinks, Settings |
| Admin | Dashboard, Resellers, Orders, Settings |

`public/icons.js` holds the icon set. The Broadcast, Analyse, Templates, Flows, Shortlinks, Settings
and Developers glyphs are Helo's own SVGs, lifted from their sidebar so the panel matches; the
Dashboard, Orders, Store and Customers ones are drawn in the same 20x20 single-colour grid. To add a
section, add an entry to `NAV` in `public/app.js` and a matching icon to `icons.js` — a section
either carries `children` (collapsible) or its own `fn` (a page).

## Product images

`POST`/`PUT /api/products` are `multipart/form-data`. The optional `image` field accepts
JPG/PNG/WebP/GIF up to 5MB; anything else is ignored rather than stored. Files land in
`public/uploads/` under a generated name, and deleting a product deletes its image.

## Data

`data/db.json` holds everything and is rewritten on every mutation. Two notes:

- It is **gitignored**, so it is a local dev store, not a production database.
- Stop `npm run dev` before editing it by hand or running `node migrate.js`. The server keeps the
  DB in memory and will overwrite external changes on the next save.

`migrate.js` is idempotent and safe to re-run; it backfills reseller codes, product image fields,
order status, and the campaign-history shape. Run it after pulling changes to an existing DB.

## Reseller codes

Every reseller is issued a random code (e.g. `K7M2PQ`) at sign-up and stored in `users[].resellerCode`.
Buyers type it on the sign-up form to link themselves to that reseller, and must also give a phone
number. Resellers can change their code under Settings; existing customers stay linked because they
are tied by `resellerId`. `RESELLER_SIGNUP_CODE` in `.env` is *not* a per-reseller code — it is the
single master secret that decides who is allowed to register as a reseller at all.

## Connect Helo

`helo.js` is a finished client for the Helo-WhatsApp v1 API (https://docs.helo.ai/helo-whatsapp,
API explorer tab). It authenticates, discovers the WABA, lists templates, and sends one template
message per recipient. Fill these in `.env` to switch from simulation to real sending:

| Variable | Notes |
| --- | --- |
| `HELO_BASE_URL` | UAT `https://uat-wabaapp.helo.ai:8058` (as published), production `https://wabaapp.helo.ai` |
| `HELO_USER_ID` | The Helo userId or userName |
| `HELO_API_KEY` | Helo API key. Optional: accounts whose panel has no Generate button use `HELO_PASSWORD` instead |
| `HELO_PASSWORD` | Account password, used only when no API key is set |
| `HELO_SIGNIN_PATH` | The password sign-in route. Helo does not publish it, so this is configurable and defaults to a guess |
| `HELO_SIGNIN_USER_FIELD` / `HELO_SIGNIN_PASS_FIELD` | Field names for the username and password in that request body |
| `HELO_FROM` | Your sender number, digits with country code, no `+`. No default is guessed |
| `HELO_WABA_ID` | Optional. Discovered automatically when empty |
| `HELO_BATCH_SIZE` | **Not a batch size.** How many single-send requests may be in flight at once (capped at 20) |
| `HELO_CHECK_CONSENT` | Defaults to `true`; only send to customers who opted in |

Endpoints used, and how the responses are read:

- `POST /user/authenticate` with `{userId, apiKey}`, or `POST /user/sign-in-user` with
  `{userName, password}`; the token is `data.token`, valid about 4 hours
  (`data.expiresIn` is a millisecond epoch, not a duration). Sent as `Authorization: Bearer <token>`.
  A 401 triggers one silent re-auth and retry.
- `GET /business/getAllWabas` to find the WhatsApp Business account.
- `GET /templates/list/{whatsappBusinessId}?limit=999&page=1`. Helo is inconsistent about shape, so
  `name`/`templateName`, `status`/`status_name` and `id`/`templateId` are all read defensively.
- `POST /messages/single` with one complete template message. **Helo reports most failures with
  HTTP 200 and the real error buried in the body** (`data.status: "false"`, `data.code`), so those
  are treated as failures — a 3501 for a bad `template.language.code` must not read as accepted.
  The template list can also return a display name such as `English` where the send API wants a
  code, so language values are normalised (`English` to `en`) before they reach the wire.

Sending is per-recipient with bounded concurrency, so a campaign of N buyers is N requests. The
campaign is recorded as `Sending` and finished by a background worker, which keeps a one-per-recipient
credit reservation and refunds every message Helo did not accept. The UI polls while a campaign is in
flight. That shape is the same one direct Meta needs, since Meta has no bulk endpoint either.

While any of `HELO_BASE_URL`, `HELO_USER_ID` and an API key or password is blank, sends are simulated
and logged to the console, and the panel shows a "not connected" state. Admins can check the live
connection under **Developers**, which reports the host, WABA count, sender number and approved-template
count without sending anything. **Check that page before your first real campaign** — it is the only
step that proves the credentials, the sign-in path and the endpoint paths without messaging anyone.

### Helo UAT is currently down

Checked 29 Sep 2026. The published UAT host `uat-wabaapp.helo.ai:8058` refuses TCP connections, and
port 443 answers but fails every request with a server-side error, identically for every path, method
and set of headers:

- `POST` any path: `500 TypeError: response.header is not a function` (`app/src/api/routes/index.js:122`)
- any path under `/v1`: `500 TypeError: Cannot read properties of undefined (reading 'path')`
- `GET` any other path: `404` with `[object Object]`

Because bogus paths under `/v1` fail the same way as real ones, the crash happens before routing, so
this is not a wrong-base-URL problem. Reported to Helo; the deployment needs fixing on their side.
Until then, point `HELO_BASE_URL` at production and verify reachability from your own network.

Run `node migrate.js` once before first use so the campaign columns exist, and stop the server
first — `data/db.json` is held in memory and would be overwritten.

## Not built yet

Shortlinks, Governance, Analyse and the public API are placeholders. Delivered/read/reply rates and
the reports that depend on them need Helo DLR webhooks, which are deliberately phase 2. There is no
payment gateway: order amounts are recorded and displayed but never charged.
