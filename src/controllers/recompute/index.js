import { jsonResponse } from "../../lib/http.js";
import { aggregateOverview } from "../../lib/pipeline.js";
import { allocate, suggest } from "../../lib/compute.js";
import {
  loadCompanyData, loadCompanyMids, loadCurrentConfig, globalBestMid, resolveCompanyId,
  hashString, recencyKey, txFingerprint,
} from "../../lib/company-data.js";

// HTTP trigger — recomputes ONLY the authenticated caller's company. The all-companies sweep
// runs from the cron (recomputeBankMid), not over HTTP. `?nocache=1` forces a full combo scan
// (bypasses the aggregation cache) — used to verify the cached path is byte-for-byte identical.
export async function handleRecompute(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });
  const noCache = url.searchParams.get("nocache") === "1";
  const result = await recomputeCompany(env, cid, null, { noCache });
  if (result.error) return jsonResponse(result, { status: 500 });
  return jsonResponse(result);
}

// cron entry point — recompute every company that has a published config.
export async function recomputeBankMid(env) {
  return recomputeAll(env);
}

async function recomputeAll(env) {
  const companies = (await env.DB.prepare(
    "SELECT DISTINCT company_id FROM config_versions WHERE is_current = 1"
  ).all()).results ?? [];
  const out = [];
  for (const { company_id } of companies) {
    out.push({ company_id, ...(await recomputeCompany(env, company_id)) });
  }
  return { result: "SUCCESS", companies: out };
}

// Config-driven recompute for ONE company: read its published config, pull its combos,
// run the SAME lib the dashboard uses (aggregateOverview + allocate), and materialise
// bank_mid (counts) + suggestions (the per-bank allocation the checkout serves).
export async function recomputeCompany(env, companyId, config = null, opts = {}) {
  if (!config) config = await loadCurrentConfig(env, companyId);
  if (!config) return { error: `no current config for company ${companyId}` };

  // Aggregation cache (Task 1). The combo scan + aggregateOverview is the slow part, and its
  // output depends ONLY on phaseA (which mids/noise), the recency weighting, and the underlying
  // transactions/mids — NOT on strategy/overrides. So when all three signatures match the cached
  // agg, reuse it and re-run just allocate(); otherwise recompute and refresh the cache.
  const phaseaHash = hashString(JSON.stringify(config.phaseA || {}));
  const recHash = recencyKey(config.strategy);
  const fingerprint = await txFingerprint(env, companyId);

  let agg = null;
  let cacheHit = false;
  if (!opts.noCache) {
    const row = await env.DB.prepare(
      "SELECT phasea_hash, recency_hash, tx_fingerprint, agg_json FROM recompute_cache WHERE company_id = ?"
    ).bind(companyId).first();
    if (row && row.phasea_hash === phaseaHash && row.recency_hash === recHash && row.tx_fingerprint === fingerprint) {
      agg = JSON.parse(row.agg_json);
      cacheHit = true;
    }
  }

  // MIDs are always needed for displayMids (cheap; not part of the cached blob).
  const mids = await loadCompanyMids(env, companyId);
  // coerce both sides — mids.merchant_id may come back as a string; match isCountable's Number().
  const want = new Set((config.phaseA.mids || []).map(Number));
  const displayMids = mids.filter((m) => want.has(Number(m.merchantId)));

  if (!agg) {
    const { combos, banks } = await loadCompanyData(env, companyId);
    agg = aggregateOverview(combos, banks, mids, config);
    // Refresh the cache slot (INSERT OR REPLACE — one row per company).
    await env.DB.prepare(
      "INSERT OR REPLACE INTO recompute_cache (company_id, phasea_hash, recency_hash, tx_fingerprint, agg_json, computed_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).bind(companyId, phaseaHash, recHash, fingerprint, JSON.stringify(agg)).run();
  }

  const ctx = { globalBest: globalBestMid(agg, displayMids, config.strategy, suggest) };
  const overrides = {};
  for (const o of config.overrides || []) overrides[o.bankId] = o;

  const suggIns = env.DB.prepare(
    "INSERT INTO suggestions (company_id, bank_id, allocation_json, source) VALUES (?, ?, ?, ?)"
  );
  const bmIns = env.DB.prepare(
    "INSERT INTO bank_mid (company_id, bank_id, mid_id, success_count, fail_count) VALUES (?, ?, ?, ?, ?)"
  );

  // Build each table's write as DELETE + all inserts in ONE batch. env.DB.batch is a single
  // transaction, so the checkout never sees an empty/partial suggestions table mid-recompute.
  const suggStmts = [env.DB.prepare("DELETE FROM suggestions WHERE company_id = ?").bind(companyId)];
  const bmStmts = [env.DB.prepare("DELETE FROM bank_mid WHERE company_id = ?").bind(companyId)];
  for (const bank of agg) {
    const a = allocate(bank.scoreCounts, displayMids, config.strategy, overrides[bank.bankId], ctx);
    suggStmts.push(suggIns.bind(companyId, bank.bankId, JSON.stringify(a.allocation), a.source));
    for (const [midId, mc] of Object.entries(bank.counts)) {
      bmStmts.push(bmIns.bind(companyId, bank.bankId, Number(midId), mc.overall.s, mc.overall.f));
    }
  }

  // D1 drops the connection ("Network connection lost") when a single batch() is too large, which
  // happens at scale (Apollo has ~2,400 banks). Chunk the writes; the DELETE stays as the first
  // statement of the first chunk so it runs in the same transaction as the first inserts.
  await runChunked(env, suggStmts);
  await runChunked(env, bmStmts);

  return { banksUpdated: agg.length, midRows: bmStmts.length - 1, version: config.version, cacheHit };
}

// Run prepared statements in batches of `size` (each batch = one transaction/round-trip).
async function runChunked(env, stmts, size = 500) {
  for (let i = 0; i < stmts.length; i += size) {
    await env.DB.batch(stmts.slice(i, i + size));
  }
}
