// company-data.js — per-company data loads + small helpers shared by the recompute and
// the dashboard read endpoints. The combo query mirrors the dashboard's /overview-combos:
// grouped by exactly the rule surface, response_text REFID-stripped, + an age band for recency.
import { verifyToken } from "./auth.js";

// Fail closed — never sign/verify with a hardcoded fallback secret (that would let anyone
// forge a token). A missing AUTH_SECRET is a deploy misconfig, not something to paper over.
export function authSecret(env) {
  if (!env.AUTH_SECRET) throw new Error("AUTH_SECRET is not configured");
  return env.AUTH_SECRET;
}

// Bearer-token payload ({uid, cid}) or null.
export async function authPayload(request, env) {
  const h = request.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? verifyToken(m[1], authSecret(env)) : null;
}

// strip the per-txn "REFID:<uid>" tail so ~364 reasons collapse to ~47 clean ones.
const cleanText = (c) =>
  `rtrim(CASE WHEN instr(${c},'REFID:')>0 THEN substr(${c},1,instr(${c},'REFID:')-1) ELSE ${c} END)`;

// bucket a date into a bounded age band (relative to now) for recency weighting.
const ageBand = (c) => `CASE
  WHEN julianday('now') - julianday(${c}) <= 7   THEN 'w1'
  WHEN julianday('now') - julianday(${c}) <= 30  THEN 'm1'
  WHEN julianday('now') - julianday(${c}) <= 90  THEN 'm3'
  WHEN julianday('now') - julianday(${c}) <= 180 THEN 'm6'
  WHEN julianday('now') - julianday(${c}) <= 365 THEN 'y1'
  ELSE 'old' END`;

// { combos, banks, mids } for one company — the input to aggregateOverview + allocate.
export async function loadCompanyData(env, companyId) {
  const comboSql = `
    SELECT bn.bank_id AS bank_id, m.id AS mid_id, t.merchant_id AS merchant_id,
           CASE WHEN t.bill_cycle = 1 THEN 'initial' WHEN t.bill_cycle >= 2 THEN 'rebill' ELSE 'unknown' END AS cyc,
           t.response_type AS response_type, ${cleanText('t.response_text')} AS response_text, t.card_type AS card_type,
           ${ageBand('t.date_created')} AS band,
           COUNT(*) AS count
    FROM transactions t
    JOIN bins bn ON bn.bin_number = t.card_bin
    JOIN mids m  ON m.merchant_id = t.merchant_id AND m.company_id = t.company_id
    WHERE t.company_id = ? AND bn.bank_id IS NOT NULL
    GROUP BY bn.bank_id, m.id, t.merchant_id, cyc, t.response_type, ${cleanText('t.response_text')}, t.card_type, band`;
  const combos = (await env.DB.prepare(comboSql).bind(companyId).all()).results ?? [];
  const banks = (await env.DB.prepare('SELECT id, name FROM banks').all()).results ?? [];
  const mids = ((await env.DB.prepare(
    'SELECT id, name, merchant_id FROM mids WHERE company_id = ? ORDER BY merchant_id'
  ).bind(companyId).all()).results ?? []).map((r) => ({ id: r.id, name: r.name, merchantId: r.merchant_id }));
  return { combos, banks, mids };
}

// the current published config for a company (or null). Parses config_json.
export async function loadCurrentConfig(env, companyId) {
  const row = await env.DB.prepare(
    'SELECT config_json, version FROM config_versions WHERE company_id = ? AND is_current = 1 ORDER BY version DESC LIMIT 1'
  ).bind(companyId).first();
  if (!row) return null;
  const config = JSON.parse(row.config_json);
  config.version = row.version;
  return config;
}

// Resolve the company for a request. A supplied-but-invalid x-api-key returns null (caller → 401);
// no key falls back to ?company=<id>, else 1 (staging single-tenant default — make the key
// REQUIRED before production, see DASHBOARD-HANDOFF.md).
// STRICT — for every tenant-scoped dashboard/settings/onboarding/config endpoint. Requires a
// valid Bearer token (or a matching api key). No `?company=` and no default: unauthenticated → null (401).
export async function resolveCompanyId(env, request, url) {
  if (request.headers.get('authorization')) {
    const payload = await authPayload(request, env);
    return payload && payload.cid != null ? payload.cid : null;
  }
  const key = request.headers.get('x-api-key');
  if (key) {
    const c = await env.DB.prepare('SELECT id FROM companies WHERE api_key = ?').bind(key).first();
    return c ? c.id : null;
  }
  return null;
}

// PERMISSIVE — for the checkout serving endpoint (/api/suggest) only, which has no dashboard
// token. Prefers an api key, then ?company, then the legacy company-1 default.
export async function resolveServingCompanyId(env, request, url) {
  const key = request.headers.get('x-api-key');
  if (key) {
    const c = await env.DB.prepare('SELECT id FROM companies WHERE api_key = ?').bind(key).first();
    return c ? c.id : null;
  }
  const param = url.searchParams.get('company');
  if (param && /^\d+$/.test(param)) return parseInt(param, 10);
  return 1;
}

// tiny stable string hash (djb2) — used for the phaseA hash (skip re-aggregate when unchanged).
export function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// best MID across ALL banks — the "no data" fallback for thin banks. Mirrors overview.js.
export function globalBestMid(agg, displayMids, strategy, suggest) {
  const acc = {};
  for (const b of agg) for (const [mid, mc] of Object.entries(b.scoreCounts)) {
    const m = acc[mid] || (acc[mid] = { overall: { s: 0, f: 0 }, initial: { s: 0, f: 0 }, rebill: { s: 0, f: 0 } });
    for (const k of ['overall', 'initial', 'rebill']) { m[k].s += mc[k].s; m[k].f += mc[k].f; }
  }
  const s = suggest(acc, displayMids, { ...strategy, minAttempts: 0, floorPct: 0, explorePct: 0, noData: 'none' });
  return s.allocation[0] ? s.allocation[0].mid : null;
}
