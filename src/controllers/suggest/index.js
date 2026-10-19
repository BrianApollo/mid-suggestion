import { jsonResponse } from "../../lib/http.js";
import { resolveServingCompanyId, loadCurrentConfig } from "../../lib/company-data.js";
import { pickTestMid } from "../../lib/ab-test.js";

// GET /api/suggest?bin=XXXXXX — the checkout lookup. Feeds back whatever suggestion the
// last recompute materialised for this company + the BIN's issuing bank.
//
// The base (control) MID comes from the materialised `suggestions` table, but A/B `test`
// overrides are applied LIVE from the company's current config_versions row on each request —
// so editing a test override takes effect immediately without waiting for a recompute.
//
// NOTE (checkout contract): the response shape { merchant_id, merchant_name, issuer } is
// UNCHANGED from the original so the checkout page is unaffected; `source`/`allocation` are
// additive. Deployed to STAGING only; review before live.
export async function handleSuggest(request, env, url) {
  const bin = url.searchParams.get("bin");
  if (!bin || !/^\d{6}$/.test(bin)) {
    return jsonResponse({ error: "bin must be a 6-digit number" }, { status: 400 });
  }
  const companyId = await resolveServingCompanyId(env, request, url);
  if (companyId == null) return jsonResponse({ error: "invalid api key" }, { status: 401 });

  const bank = await env.DB.prepare(
    `SELECT b.bank_id, ba.name AS issuer
     FROM bins b JOIN banks ba ON ba.id = b.bank_id
     WHERE b.bin_number = ?`
  ).bind(bin).first();
  if (!bank || bank.bank_id == null) {
    return jsonResponse({ error: "no issuing bank found for this BIN" }, { status: 404 });
  }

  const sugg = await env.DB.prepare(
    "SELECT allocation_json, source FROM suggestions WHERE company_id = ? AND bank_id = ?"
  ).bind(companyId, bank.bank_id).first();
  if (!sugg) {
    return jsonResponse({ error: "no suggestion for this bank yet — run a recompute" }, { status: 404 });
  }

  const allocation = JSON.parse(sugg.allocation_json);

  // Control MID — "what we're supposed to suggest". Resolve the base allocation, ignoring any
  // test entry a previous recompute may have baked in (the live config below is authoritative
  // for A/B tests). If there are no non-test entries, fall back to the whole allocation.
  const baseEntries = allocation.filter((a) => !a.test);
  const suggestedMid = pickByWeight(baseEntries.length ? baseEntries : allocation);
  if (suggestedMid == null) {
    return jsonResponse({ error: "empty allocation" }, { status: 404 });
  }

  // Live A/B test: if the company's current config has a `test` override for this bank, roll
  // (100 - share) per request to serve either the control MID or the test MID. One MID out.
  let midId = suggestedMid;
  let source = sugg.source;
  let roll = null;
  const config = await loadCurrentConfig(env, companyId);
  const test = (config?.overrides || []).find(
    (o) => o.mode === "test" && Number(o.bankId) === Number(bank.bank_id)
  );
  if (test?.config?.mid != null) {
    ({ mid: midId, roll } = pickTestMid(suggestedMid, test.config.mid, test.config.share ?? 15));
    source = "override:test";
  }

  const mid = await env.DB.prepare(
    "SELECT merchant_id, name AS merchant_name FROM mids WHERE id = ? AND company_id = ?"
  ).bind(midId, companyId).first();
  if (!mid) {
    return jsonResponse({ error: "suggested MID not found" }, { status: 404 });
  }

  return jsonResponse({
    merchant_id: mid.merchant_id,
    merchant_name: mid.merchant_name,
    issuer: bank.issuer,
    source,                              // additive — 'strategy' | 'override:test' | ...
    allocation: [{ mid: midId, pct: 100 }], // additive — the single MID actually served
    roll,                                // additive — A/B roll in [1, 100]; null when no test override
  });
}

// A suggestion may be a split/test (multiple MIDs with pct). Pick one by weight per call.
function pickByWeight(allocation) {
  if (!allocation || !allocation.length) return null;
  if (allocation.length === 1) return allocation[0].mid;
  const total = allocation.reduce((s, a) => s + (a.pct || 0), 0) || 100;
  let r = Math.random() * total;
  for (const a of allocation) { r -= (a.pct || 0); if (r <= 0) return a.mid; }
  return allocation[0].mid;
}
