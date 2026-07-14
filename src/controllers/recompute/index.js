import { jsonResponse } from "../../lib/http.js";
import { aggregateOverview } from "../../lib/pipeline.js";
import { allocate, suggest } from "../../lib/compute.js";
import { loadCompanyData, loadCurrentConfig, globalBestMid, resolveCompanyId } from "../../lib/company-data.js";

// HTTP trigger — recomputes ONLY the authenticated caller's company. The all-companies sweep
// runs from the cron (recomputeBankMid), not over HTTP.
export async function handleRecompute(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });
  const result = await recomputeCompany(env, cid);
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
export async function recomputeCompany(env, companyId, config = null) {
  if (!config) config = await loadCurrentConfig(env, companyId);
  if (!config) return { error: `no current config for company ${companyId}` };

  const { combos, banks, mids } = await loadCompanyData(env, companyId);
  // coerce both sides — mids.merchant_id may come back as a string; match isCountable's Number().
  const want = new Set((config.phaseA.mids || []).map(Number));
  const displayMids = mids.filter((m) => want.has(Number(m.merchantId)));

  const agg = aggregateOverview(combos, banks, mids, config);
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

  await env.DB.batch(suggStmts);   // atomic: old rows replaced by new in one transaction
  await env.DB.batch(bmStmts);

  return { banksUpdated: agg.length, midRows: bmStmts.length - 1, version: config.version };
}
