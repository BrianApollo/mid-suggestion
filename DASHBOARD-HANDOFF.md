# Dashboard integration — handoff

This branch (`feat/dashboard-config-driven-suggestions`) adds the backend for the routing
dashboard on top of the existing single-tenant worker. Everything here is deployed and tested
on **staging only** (`--env dev`). **Live (`mid-suggestion` / `mid-suggestion-db`) is untouched.**

## What it does (the shape of it)

The dashboard lets each company edit a **config** (which MIDs to count, noise filters to drop,
a scoring strategy, manual overrides). On **publish**, the backend stores the config and
**recomputes**: it reads the company's config, pulls its transactions as grouped *combos*, runs
the SAME pure lib the UI uses (`src/lib/pipeline.js` + `src/lib/compute.js`) to score each bank,
and materialises one **suggestion per bank** into a new `suggestions` table. The checkout's
`/api/suggest` just reads that table. So: **edit rules → publish → recompute → checkout serves it.**

The key idea: there is **no hardcoded filter any more**. `isCountable`/`aggregateOverview`/
`allocate` in `src/lib/*` *are* the filter + the strategy, driven entirely by the stored config.
Preview (UI) == Live (recompute) because it's literally the same code.

## What changed

**Migration** `migrations/0010_dashboard_multitenancy.sql` (applied to staging):
- `company_id` on `transactions`, `mids`, `bank_mid` (DEFAULT 1 bootstraps existing data as company 1 = Accotta).
- new tables: `companies`, `config_versions` (versioned config, `is_current`), `suggestions` (per-bank allocation).
- `bank_mid` rebuilt with `company_id` in its PK.

**New/changed code:**
- `src/lib/pipeline.js`, `compute.js`, `validate.js` — **copied verbatim from the dashboard UI repo** (`jayamin123/mid-suggestion-dashboard`, `app/lib/`). Keep in sync; they're the shared source of truth.
- `src/lib/company-data.js` — per-company combo query, config load, company resolution, helpers.
- `src/controllers/config/index.js` — `GET /api/config`, `GET /api/config/versions`, `POST /api/publish`.
- `src/controllers/recompute/index.js` — rewritten: config-driven, per-company, writes `bank_mid` + `suggestions`. `recomputeBankMid(env)` (the cron entry) now loops every company with a current config.
- `src/controllers/dashboard/index.js` — the UI's read endpoints: `mids, banks, options, overview-combos, dataset, tables, table/:name, transactions`.
- `src/controllers/suggest/index.js` — now serves the **materialised** suggestion. **Response shape `{merchant_id, merchant_name, issuer}` is UNCHANGED** (`source`/`allocation` added). Review before this reaches live.
- `src/index.js` — routes wired; ingest `/api/transactions?startDate` is matched before the dashboard browser form.

## Auth & onboarding (added after the first pass)

A company can now self-onboard: sign up → connect CheckoutChamp → pull data → derive MIDs.

- **Auth** (`src/lib/auth.js`, `controllers/auth`): PBKDF2 password hashing + HMAC signed tokens
  (`{uid, cid}`). `POST /api/auth/signup` (creates company + user + seeds a default config),
  `POST /api/auth/login`, `GET /api/me`. `resolveCompanyId` reads the Bearer token first
  (→ 401 if invalid), then `x-api-key`, then `?company=`, else company 1.
- **Settings / connection** (`controllers/settings`): `GET/PUT /api/settings`,
  `POST /api/settings/test`. Saves the company's CC login/password, runs a live CheckoutChamp
  test, and records status (`connected` / `invalid_credentials` / `ip_not_whitelisted` / …).
- **Onboarding** (`controllers/onboarding`): `POST /api/ingest` (per-company, page-continuation
  so the UI can show a progress bar; injects the company's own CC creds via `cc-client.applyCreds`)
  + `POST /api/company/init` (derive mids from their transactions → point the config at them → recompute).
- **Tenancy guards:** only company 1 (Accotta) may fall back to the proxy's default creds; every
  other company must supply its own (else it could pull Accotta's data). `migrations/0013` makes
  transactions `UNIQUE(company_id, cc_transaction_id)` so two companies never collide.
- **Auth secret:** set as a Worker secret — `wrangler secret put AUTH_SECRET --env dev`. Set one
  for prod before going live (code falls back to a staging default otherwise).
- **Login for the demo:** `admin@accotta.com` / `asdf1234` (company 1). New signups start disconnected
  and are routed to Setup.

**Still to do for real multi-tenant CC:** confirm the `checkout-champ-proxy` honours per-request
`loginId`/`password` (we pass them; Accotta works via the default). Encrypt `cc_password`
(currently plain, staging only). Decide the whitelist IP to display (Settings shows `env.WHITELIST_IP`).

## Security hardening (from a review of the auth/onboarding code)

Fixed and deployed:
- **No unauthenticated tenant access** — `resolveCompanyId` is now STRICT: it requires a valid
  Bearer token (or matching `x-api-key`) and no longer honours `?company=` or defaults to 1.
  The checkout `/api/suggest` uses a separate `resolveServingCompanyId` (api-key / `?company` / 1)
  since it has no dashboard token.
- **Fail-closed auth secret** — a missing `AUTH_SECRET` now throws instead of using a committed
  fallback (which would let anyone forge tokens). Set it: `wrangler secret put AUTH_SECRET --env dev`.
- **Tokens expire** (30d `exp`, checked in `verifyToken`) and the signature compare is constant-time.
- **Signup is safe** — user insert is wrapped so a duplicate email returns 409 and rolls back the
  orphan company (no leaked rows); CheckoutChamp connection test no longer reads an empty-array
  error envelope as "connected".
- `/api/recompute` now requires auth and recomputes only the caller's company; the legacy
  unauthenticated `/api/transactions?startDate` ingest route was retired (cron still ingests directly).
- The seeded staging password is a throwaway — **rotate it before any non-staging use**.

## Multi-tenant CheckoutChamp proxy (fixed)

The `checkout-champ-proxy` overwrote any per-company `loginId`/`password` with its own default
account (`.set()` unconditionally) → every company pulled Accotta's data (e.g. Sync MIDs returned
Accotta's merchants). Fix: a duplicate worker **`checkout-champ-proxy-mt/`** (in this repo) that only
injects the default when the caller passed nothing. **Staging** binds `CC_PROXY` → the duplicate;
**live** still binds the original (untouched). Long term: apply the 2-line guard to the original and
drop the duplicate. Verified: same creds, new proxy → the company's own merchants; old proxy → Accotta's.

**Cred-passing audit — every place we call CheckoutChamp:**
- `/api/settings/test` (`testCheckoutChamp`), `/api/mids/sync` (`queryMerchants`), `/api/ingest`
  (`ingestTransactions`) — all pass `{login: cc_login, password: cc_password}` ✅ per-company.
- **The scheduled cron ingest (`index.js`) passes NO creds → default account (Accotta), company 1 only.**
  New companies' data does NOT auto-refresh on the cron; they rely on "Pull my data" / CSV import.
  Decision needed: make the cron loop per-company (each with its creds) vs keep it Accotta-only.

## Deployed (staging)

- Worker: **https://mid-suggestion-dev.management-23c.workers.dev** (`wrangler deploy --env dev`).
- DB: `dev-mid-suggestion-db` (`39569092…`). Company 1 = Accotta (54,994 txns, 1,076 banks with data → 1,076 suggestions).
- Dashboard UI (Cloudflare Pages): **https://mid-suggestion-dashboard.pages.dev** → talks to the staging worker.
- Recompute: `GET /api/recompute?company=1` (or no param = all companies). Publish auto-recomputes.

## Verified

- Every bank with data gets a suggestion (1,076/1,076, 0 empty).
- Publish write-path: validate → new version → recompute → suggestions updated.
- `/api/suggest?bin=<real bin>` returns the materialised pick; unknown BIN → 404 (correct).
- All UI views compute correctly against the deployed worker.

## Fixed after a correctness review (already in this branch)

- **Atomic recompute** — each table's `DELETE` + all `INSERT`s run in one `env.DB.batch()` (single transaction), so the checkout never sees an empty/partial `suggestions` table mid-recompute.
- **Publish ordering** — the new config is stored as `is_current = 0`, recomputed, and only flipped to current **after** a successful recompute; a failed publish never leaves a live-but-broken config.
- **MID type coercion** — `displayMids` coerces both sides (`Number()`), matching `isCountable`, so a stringly-typed `merchant_id` can't silently empty every suggestion.
- **Invalid api-key → 401** (not a silent fall-through to company 1). Migration `0011` adds `UNIQUE(company_id, version)` + one-`is_current`-per-company.

## Caveats / TODO before production (deliberately deferred)

1. **Require the api-key** — with no key, `resolveCompanyId` still defaults to **company 1** (so the keyless staging UI works). Before real multi-tenancy: make the key required, and have the ingest set `company_id` per company (drop the `DEFAULT 1` bootstrap).
2. **CC credentials** live as plain columns on `companies` (staging only) — move to a secret store before live.
3. **`/api/suggest`** depends on `suggestions` being populated. New/zero-data BINs (the old exploration logic handled these) currently 404 — decide whether to keep a fallback.
4. Publish recompute is **synchronous** (~5s for Accotta). Fine now; consider backgrounding at scale.
