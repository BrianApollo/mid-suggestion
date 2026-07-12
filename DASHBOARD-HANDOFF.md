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
