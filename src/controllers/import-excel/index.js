import { jsonResponse } from "../../lib/http.js";
import { resolveCompanyId } from "../../lib/company-data.js";
import { persistTransactions } from "../transactions/index.js";

// POST /api/import-excel — import a CheckoutChamp "Transaction Details" CSV export into the
// transactions table (tagged to the caller's company). Send the CSV as the raw request body.
// Only `type == Sale` rows are imported (mirrors the live ingest's txnType=SALE). Rows are
// deduped against existing ones by cc_transaction_id, so re-importing is safe.
//
// NOTE: .xlsx is a binary format we can't parse in a Worker without a library — export/convert
// the sheet to CSV first (the frontend can do this before POSTing).

// Columns we read from the export header (by name, so column order/extra columns don't matter).
const REQUIRED = [
  "date", "type", "result", "response", "merchantId", "mid",
  "cardBin", "cardLast4", "cardType", "orderId", "txnId", "billCycle", "transactionId",
];

// "Success" → SUCCESS, "Soft Decline" → SOFT_DECLINE, "Hard Decline" → HARD_DECLINE
const normType = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "_");

export async function handleImportExcel(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });

  const text = await request.text();
  if (!text || !text.trim()) {
    return jsonResponse({ error: "empty body — POST the CSV export as the request body" }, { status: 400 });
  }

  const rows = parseCsv(text);
  // The export has a preamble ("Transaction Details", "Date Range …") before the header row.
  const headerIdx = rows.findIndex((r) => (r[0] || "").trim().toLowerCase() === "date");
  if (headerIdx === -1) {
    return jsonResponse({ error: "could not find the header row (expected a column named 'date')" }, { status: 400 });
  }

  const header = rows[headerIdx].map((h) => h.trim());
  const col = {};
  header.forEach((h, i) => { if (!(h in col)) col[h] = i; });   // first occurrence wins
  const missing = REQUIRED.filter((c) => !(c in col));
  if (missing.length) return jsonResponse({ error: `missing columns: ${missing.join(", ")}` }, { status: 400 });

  const get = (row, name) => { const v = row[col[name]]; return v == null ? "" : v.trim(); };

  let parsed = 0, eligible = 0, skippedNonSale = 0, skippedInvalid = 0;
  const mapped = [];
  for (const row of rows.slice(headerIdx + 1)) {
    const txnId = get(row, "transactionId");
    if (!/^\d+$/.test(txnId)) continue;              // blank line / trailing "Total" row → skip
    parsed++;
    if (get(row, "type").toLowerCase() !== "sale") { skippedNonSale++; continue; }
    const dateCreated = get(row, "date");
    const responseType = normType(get(row, "result"));
    if (!dateCreated || !responseType) { skippedInvalid++; continue; }   // NOT NULL guard
    eligible++;

    const merchantId = get(row, "merchantId");
    const billCycle = get(row, "billCycle");
    mapped.push({
      transactionId: Number(txnId),
      dateCreated,
      responseType,
      responseText: get(row, "response") || null,
      merchantId: /^\d+$/.test(merchantId) ? Number(merchantId) : null,
      midNumber: get(row, "mid") || null,
      cardBin: get(row, "cardBin") || null,
      cardLast4: get(row, "cardLast4") || null,
      cardType: get(row, "cardType") || null,
      orderId: get(row, "orderId") || null,
      merchantTxnId: get(row, "txnId") || null,
      billingCycleNumber: /^-?\d+$/.test(billCycle) ? Number(billCycle) : null,
      txnType: get(row, "type") || null,   // "Sale" → persisted as SALE (upcased in persistTransactions)
    });
  }

  const countSql = "SELECT COUNT(*) n FROM transactions WHERE company_id = ?";
  const before = (await env.DB.prepare(countSql).bind(cid).first()).n;
  await persistTransactions(env, mapped, cid);       // dedup + INSERT OR IGNORE, same path as ingest
  const after = (await env.DB.prepare(countSql).bind(cid).first()).n;
  const inserted = after - before;

  console.log(`[import] company ${cid} — parsed=${parsed} eligible=${eligible} inserted=${inserted}`);
  return jsonResponse({
    ok: true,
    parsed,                            // data rows with a numeric transactionId
    eligible,                          // type == Sale and non-null date/result
    inserted,                          // new rows written
    duplicates: eligible - inserted,   // already present (deduped by cc_transaction_id)
    skippedNonSale,                    // type != Sale
    skippedInvalid,                    // missing date or result
  });
}

// Minimal RFC-4180 CSV parser: handles quoted fields, embedded commas/newlines, and "" escapes.
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\r") {
      // ignore — handled by \n
    } else if (c === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
