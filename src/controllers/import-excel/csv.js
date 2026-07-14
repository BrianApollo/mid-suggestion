// Shared CSV parsing + CheckoutChamp "Transaction Details" row→transaction mapping.
// Used by BOTH the streaming direct/R2 one-shot import (import-excel/index.js) and the
// resumable R2 background job (sync-driver's alarmR2). Keep this the single source of truth
// for the transaction model so the two paths can never drift apart.

export const REQUIRED = [
  "date", "type", "result", "response", "merchantId", "mid",
  "cardBin", "cardLast4", "cardType", "orderId", "txnId", "billCycle", "transactionId",
];
export const KEEP_TYPES = new Set(["sale", "authorize", "capture"]);

export const normType = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "_");

// A stateful, chunk-safe RFC-4180 field parser. feed(text, onRow) emits onRow(rowArray) for every
// COMPLETE row seen; partial rows are carried in the parser's state until the next feed(). Handles
// quotes, embedded commas/newlines, and "" escapes. finish(onRow) flushes a final unterminated row.
export function createCsvParser() {
  const st = { field: "", row: [], inQuotes: false, quoteSeen: false };
  function feed(text, onRow) {
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (st.quoteSeen) {
        st.quoteSeen = false;
        if (c === '"') { st.field += '"'; continue; }
        st.inQuotes = false;
      }
      if (st.inQuotes) {
        if (c === '"') st.quoteSeen = true;
        else st.field += c;
        continue;
      }
      if (c === '"') st.inQuotes = true;
      else if (c === ",") { st.row.push(st.field); st.field = ""; }
      else if (c === "\r") { /* ignore */ }
      else if (c === "\n") { st.row.push(st.field); onRow(st.row); st.row = []; st.field = ""; }
      else st.field += c;
    }
  }
  function finish(onRow) {
    if (st.quoteSeen) st.inQuotes = false;
    if (st.field.length || st.row.length) { st.row.push(st.field); onRow(st.row); }
  }
  return { feed, finish };
}

// Header detection. Returns:
//   null              → this row is still preamble (first cell isn't "date"); keep scanning
//   { error }         → header found but a required column is missing
//   { col }           → header found, col is the {name: index} map
export function parseHeader(row) {
  if ((row[0] || "").trim().toLowerCase() !== "date") return null;
  const col = {};
  row.forEach((h, i) => { const k = String(h).trim(); if (!(k in col)) col[k] = i; });
  const missing = REQUIRED.filter((c) => !(c in col));
  if (missing.length) return { error: `missing columns: ${missing.join(", ")}` };
  return { col };
}

// Map one data row to a transaction, or a skip reason. Returns:
//   { skip: 'notxnid' } — no numeric transactionId (blank/summary line) — not counted
//   { skip: 'type' }    — a type we don't keep (Refund/Void/…)
//   { skip: 'invalid' } — kept type but missing date/result
//   { txn }             — an eligible transaction to persist
export function mapRow(row, col) {
  const get = (name) => { const i = col[name]; const v = i == null ? undefined : row[i]; return v == null ? "" : String(v).trim(); };
  const txnId = get("transactionId");
  if (!/^\d+$/.test(txnId)) return { skip: "notxnid" };
  const type = get("type").toLowerCase();
  if (!KEEP_TYPES.has(type)) return { skip: "type" };
  const dateCreated = get("date");
  const responseType = normType(get("result"));
  if (!dateCreated || !responseType) return { skip: "invalid" };
  const merchantId = get("merchantId");
  const billCycle = get("billCycle");
  return {
    txn: {
      transactionId: Number(txnId),
      dateCreated,
      responseType,
      responseText: get("response") || null,
      merchantId: /^\d+$/.test(merchantId) ? Number(merchantId) : null,
      midNumber: get("mid") || null,
      cardBin: get("cardBin") || null,
      cardLast4: get("cardLast4") || null,
      cardType: get("cardType") || null,
      orderId: get("orderId") || null,
      merchantTxnId: get("txnId") || null,
      billingCycleNumber: /^-?\d+$/.test(billCycle) ? Number(billCycle) : null,
      txnType: get("type") || null,
    },
  };
}
