import { jsonResponse } from "../../lib/http.js";

export async function handleSuggest(request, env, url) {
  const bin = url.searchParams.get("bin");

  if (!bin || !/^\d{6}$/.test(bin)) {
    return jsonResponse(
      { error: "bin must be a 6-digit number" },
      { status: 400 }
    );
  }

  const exploration = await env.DB.prepare(
    `SELECT m.merchant_id, m.name AS merchant_name, ba.name AS issuer
     FROM bins b
     JOIN banks ba ON ba.id = b.bank_id
     JOIN bank_mid bm ON bm.bank_id = b.bank_id
     JOIN mids m ON m.id = bm.mid_id
     WHERE b.bin_number = ?
       AND (
         (bm.success_count + bm.fail_count) = 0
         OR (
           (bm.success_count + bm.fail_count) > 0
           AND (bm.success_count + bm.fail_count) <= 20
           AND CAST(bm.success_count AS REAL) / (bm.success_count + bm.fail_count) > 0.5
         )
       )`
  ).bind(bin).all();

  if (exploration.results.length > 0) {
    const pick = exploration.results[Math.floor(Math.random() * exploration.results.length)];
    return jsonResponse({
      merchant_id: pick.merchant_id,
      merchant_name: pick.merchant_name,
      issuer: pick.issuer,
    });
  }

  const best = await env.DB.prepare(
    `SELECT m.merchant_id, m.name AS merchant_name, ba.name AS issuer
     FROM bins b
     JOIN banks ba ON ba.id = b.bank_id
     JOIN bank_mid bm ON bm.bank_id = b.bank_id
     JOIN mids m ON m.id = bm.mid_id
     WHERE b.bin_number = ?
     ORDER BY CAST(bm.success_count AS REAL) / NULLIF(bm.success_count + bm.fail_count, 0) DESC
     LIMIT 1`
  ).bind(bin).first();

  if (!best) {
    return jsonResponse(
      { error: "no MID found for this BIN" },
      { status: 404 }
    );
  }

  return jsonResponse({
    merchant_id: best.merchant_id,
    merchant_name: best.merchant_name,
    issuer: best.issuer,
  });
}
