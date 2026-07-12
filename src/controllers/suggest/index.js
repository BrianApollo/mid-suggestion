import { jsonResponse } from "../../lib/http.js";
import { resolveCompanyId } from "../../lib/company-data.js";

// GET /api/suggest?bin=XXXXXX — the checkout lookup. Feeds back whatever suggestion the
// last recompute materialised for this company + the BIN's issuing bank. No live compute.
//
// NOTE (checkout contract): the response shape { merchant_id, merchant_name, issuer } is
// UNCHANGED from the original so the checkout page is unaffected; `source`/`allocation` are
// additive. What changed is the source of truth — it now reads the config-driven `suggestions`
// table instead of computing from bank_mid live. Deployed to STAGING only; review before live.
export async function handleSuggest(request, env, url) {
  const bin = url.searchParams.get("bin");
  if (!bin || !/^\d{6}$/.test(bin)) {
    return jsonResponse({ error: "bin must be a 6-digit number" }, { status: 400 });
  }
  const companyId = await resolveCompanyId(env, request, url);

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
  const midId = pickByWeight(allocation);
  if (midId == null) {
    return jsonResponse({ error: "empty allocation" }, { status: 404 });
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
    source: sugg.source,     // additive
    allocation,              // additive — lets the caller see splits/tests
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
