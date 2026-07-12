import { jsonResponse } from "../../lib/http.js";
import { aggregateOverview } from "../../lib/pipeline.js";
import { allocate, suggest } from "../../lib/compute.js";
import { loadCompanyData, loadCurrentConfig, globalBestMid } from "../../lib/company-data.js";

const INSERT_CHUNK = 50;

export async function handleRecompute(request, env, url) {
  const param = url.searchParams.get("company");
  const result = param && /^\d+$/.test(param)
    ? await recomputeCompany(env, parseInt(param, 10))
    : await recomputeAll(env);
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
export async function recomputeCompany(env, companyId) {
  const config = await loadCurrentConfig(env, companyId);
  if (!config) return { error: `no current config for company ${companyId}` };

  const { combos, banks, mids } = await loadCompanyData(env, companyId);
  const displayMids = mids.filter((m) => config.phaseA.mids.includes(m.merchantId));

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

  const suggStmts = [];
  const bmStmts = [];
  for (const bank of agg) {
    const a = allocate(bank.scoreCounts, displayMids, config.strategy, overrides[bank.bankId], ctx);
    suggStmts.push(suggIns.bind(companyId, bank.bankId, JSON.stringify(a.allocation), a.source));
    for (const [midId, mc] of Object.entries(bank.counts)) {
      bmStmts.push(bmIns.bind(companyId, bank.bankId, Number(midId), mc.overall.s, mc.overall.f));
    }
  }

  // clear this company's rows, then insert the fresh set (chunked batches).
  await env.DB.batch([
    env.DB.prepare("DELETE FROM suggestions WHERE company_id = ?").bind(companyId),
    env.DB.prepare("DELETE FROM bank_mid WHERE company_id = ?").bind(companyId),
  ]);
  for (let i = 0; i < suggStmts.length; i += INSERT_CHUNK) await env.DB.batch(suggStmts.slice(i, i + INSERT_CHUNK));
  for (let i = 0; i < bmStmts.length; i += INSERT_CHUNK) await env.DB.batch(bmStmts.slice(i, i + INSERT_CHUNK));

  return { banksUpdated: agg.length, midRows: bmStmts.length, version: config.version };
}
