import { jsonResponse } from "../../lib/http.js";
import { applyCreds } from "../../lib/cc-client.js";

const PERSIST_CHUNK_SIZE = 1000;   // statements per DB.batch() round-trip. D1 caps bound params at
                                   // 100 PER STATEMENT (each row uses 14, fine) but not per batch,
                                   // so a fat batch = one round-trip for 1000 rows (~10x fewer trips).
const CC_PAGE_SIZE = 200;       // CheckoutChamp hard-caps results per page at 200 (higher values are ignored).
const DAY_CONCURRENCY = 8;      // day-windows fetched in parallel per invocation. CheckoutChamp
                               // hard-caps at 10 concurrent queries/account (RateLimitError above
                               // that), so 8 stays under the ceiling with headroom for retries.
const TIME_BUDGET_MS = 25_000;  // per invocation; resume with ?fromDate=.
const MAX_DAYS = 1200;          // safety cap on the window list (a few years).

// CheckoutChamp can't filter by more than one txnType per query, so we pull every type
// and keep only these in code (matched case-insensitively against the row's txnType field).
const ALLOWED_TXN_TYPES = new Set(["SALE", "AUTHORIZE", "CAPTURE"]);

// GET /api/transactions?startDate=&endDate=&fromDate= — pull CheckoutChamp transactions into the DB.
//
// Speed: CheckoutChamp's query cost scales with the *date-range width*, not the page (a 1-year query
// takes ~38s per page; a 1-day query ~1s). So instead of paginating one year-wide query, we iterate
// one-day windows, and for each window fetch page 1, read `totalResults`, and drain exactly
// ceil(totalResults/200) pages — no guessing whether we've reached the end. Days are processed
// DAY_CONCURRENCY at a time. Time-boxed + resumable: when the budget is hit we return `nextDate`,
// and the caller re-invokes with ?fromDate=<nextDate>. Idempotent (INSERT OR IGNORE + auth/capture
// reconcile), so re-running, overlapping, or retrying a day never duplicates or drops anything.
export async function handleTransactions(request, env, url) {
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  if (!startDate || !endDate) {
    return jsonResponse({ error: "startDate and endDate are required (YYYY-MM-DD)" }, { status: 400 });
  }
  const fromDate = url.searchParams.get("fromDate") || startDate;

  const extraParams = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (["startDate", "endDate", "fromDate", "page", "resultsPerPage"].includes(k)) continue;
    extraParams[k] = v;
  }

  const result = await ingestTransactions(env, { startDate, endDate, fromDate, extraParams });
  if (result.error) return jsonResponse(result, { status: result.status ?? 502 });

  return jsonResponse({
    result: result.hasMore ? "PARTIAL" : "COMPLETE",
    startDate,
    endDate,
    fromDate,
    throughDate: result.throughDate,   // last day fully processed this call
    daysProcessed: result.daysProcessed,
    totalFetched: result.totalFetched,     // raw rows pulled from CC (= sum of totalResults)
    totalPersisted: result.totalPersisted, // rows written after txnType filter + dedup/reconcile
    failedDays: result.failedDays,         // days that errored — safe to re-run (idempotent)
    hasMore: result.hasMore,
    nextDate: result.nextDate,
    message: result.hasMore
      ? `Processed ${fromDate}..${result.throughDate}. Re-call with ?fromDate=${result.nextDate}&startDate=${startDate}&endDate=${endDate} to continue.`
      : "Done. Call GET /api/recompute to rebuild suggestions.",
  });
}

export async function ingestTransactions(
  env,
  { startDate, endDate, fromDate, timeBudgetMs = TIME_BUDGET_MS, extraParams = {}, companyId = 1, creds = {}, mode = "missing", onProgress = null }
) {
  if (!env.CC_PROXY) return { error: "CC_PROXY service binding is not configured", status: 500 };

  const days = eachDay(fromDate || startDate, endDate);
  if (days === null) return { error: "invalid date format, expected YYYY-MM-DD", status: 400 };
  if (days.length > MAX_DAYS) return { error: `date range too wide (${days.length} days > ${MAX_DAYS})`, status: 400 };

  const startTime = Date.now();
  let totalFetched = 0, totalPersisted = 0, daysProcessed = 0;
  let nextDate = null, throughDate = null;
  const failedDays = [];

  console.log(`[txn] day-window ingest ${days[0]}..${days.at(-1)} (${days.length} days, ${DAY_CONCURRENCY}-wide, budget ${timeBudgetMs}ms)`);

  for (let i = 0; i < days.length; i += DAY_CONCURRENCY) {
    if (Date.now() - startTime > timeBudgetMs) { nextDate = days[i]; break; }
    const batch = days.slice(i, i + DAY_CONCURRENCY);

    // Fetch the batch's days in PARALLEL (fast), but PERSIST once for the whole batch. The reconcile
    // then folds a trxid's authorize and capture together in a single pass — so an auth on day 1 and
    // its capture on day 5 can't race each other into a lost capture. (See reconcileAuthCapture.)
    const fetched = await Promise.all(batch.map((d) => fetchDay(env, d, extraParams, creds)));

    const batchRows = [];
    for (const f of fetched) {
      if (f.error) { failedDays.push(f.date); continue; }
      totalFetched += f.rows.length;
      batchRows.push(...f.rows.filter((t) => ALLOWED_TXN_TYPES.has(txnTypeOf(t))));
      daysProcessed++;
      throughDate = f.date;
    }
    if (batchRows.length) {
      await persistTransactions(env, batchRows, companyId, mode);
      totalPersisted += batchRows.length;
    }
    // report progress after each ~1-2s day-chunk, so the UI moves right away (not just per batch)
    if (onProgress) { try { await onProgress({ daysProcessed, totalFetched, totalPersisted, throughDate }); } catch (_) {} }
  }

  const hasMore = nextDate !== null;
  console.log(`[txn] done — ${daysProcessed} days, fetched ${totalFetched}, persisted ${totalPersisted}, failed ${failedDays.length}, hasMore=${hasMore}`);
  return { startDate, endDate, throughDate, daysProcessed, totalFetched, totalPersisted, failedDays, hasMore, nextDate };
}

// Drain ONE day (fetch only, no writes): fetch page 1 to learn totalResults, then pull exactly
// ceil(totalResults/200) pages so we stop because we HAVE them all, not because a page "looked
// last". One retry on failure; a still-failing day returns { error } and is reported for re-run.
async function fetchDay(env, isoDate, extraParams, creds) {
  const cc = toCheckoutChampDate(isoDate);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const first = await fetchPage(env, cc, 1, extraParams, creds);
      const total = first.totalResults;
      let rows = first.rows;
      const pages = Math.ceil(total / CC_PAGE_SIZE);
      for (let p = 2; p <= pages; p++) {
        const r = await fetchPage(env, cc, p, extraParams, creds);
        rows = rows.concat(r.rows);
      }
      if (rows.length < total) {
        console.warn(`[txn] ${isoDate}: drained ${rows.length}/${total} — short`);
      }
      return { date: isoDate, rows, total };
    } catch (err) {
      if (attempt === 1) {
        console.error(`[txn] ${isoDate}: failed after retry — ${err?.message || err}`);
        return { date: isoDate, error: "day failed", detail: String(err?.message || err), rows: [] };
      }
    }
  }
}

// Fetch a single (day, page) from CheckoutChamp via the proxy. Returns { rows, totalResults }.
async function fetchPage(env, ccDate, page, extraParams, creds) {
  const upstream = new URL("https://proxy/transactions/query/");
  for (const [k, v] of Object.entries(extraParams)) upstream.searchParams.set(k, v);
  upstream.searchParams.set("startDate", ccDate);
  upstream.searchParams.set("endDate", ccDate);
  upstream.searchParams.set("resultsPerPage", String(CC_PAGE_SIZE));
  upstream.searchParams.set("exTestCards", true);
  upstream.searchParams.set("page", String(page));
  upstream.searchParams.delete("responseType");
  applyCreds(upstream, creds);

  const res = await env.CC_PROXY.fetch(upstream.toString(), { method: "POST", headers: { Accept: "application/json" } });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`non-JSON from upstream: ${text.slice(0, 120)}`); }

  const rows = extractTransactions(parsed);
  const msg = parsed?.message;
  const totalResults = msg && typeof msg === "object" && Number.isFinite(msg.totalResults) ? msg.totalResults : rows.length;
  return { rows, totalResults };
}

// ── date helpers (UTC calendar days) ─────────────────────────────────────────
function eachDay(startISO, endISO) {
  const s = parseISO(startISO), e = parseISO(endISO);
  if (!s || !e) return null;
  const out = [];
  for (let d = s; d <= e && out.length <= MAX_DAYS; d = addDays(d, 1)) out.push(fmtISO(d));
  return out;
}
function parseISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
function fmtISO(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }

function extractTransactions(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.message)) return parsed.message;
  if (Array.isArray(parsed?.data)) return parsed.data;
  if (Array.isArray(parsed?.message?.data)) return parsed.message.data;
  return [];
}

// D1 caps bound parameters at 100 per query; `company_id = ?` takes one slot, so keep the
// IN(...) list at 99 to stay at 100 total.
const LOOKUP_CHUNK = 99;
const TXN_INSERT_COLS =
  "company_id, cc_transaction_id, date_created, response_type, response_text, " +
  "merchant_id, mid_number, card_bin, card_last4, card_type, " +
  "order_id, merchant_txn_id, bill_cycle, txn_type";
const TXN_INSERT_PLACEHOLDERS = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";

const txnTypeOf = (t) => String(t.txnType ?? t.type ?? "").toUpperCase();
// Success vs Decline is derived from the CheckoutChamp `result` we store in response_type:
// "SUCCESS" = success, anything else (SOFT_DECLINE / HARD_DECLINE / …) = decline.
const isSuccess = (responseType) => String(responseType ?? "").toUpperCase() === "SUCCESS";

function bindInsert(stmt, companyId, t) {
  return stmt.bind(
    companyId, t.transactionId, t.dateCreated, t.responseType, t.responseText ?? null,
    t.merchantId ?? null, t.midNumber ?? null, t.cardBin ?? null, t.cardLast4 ?? null, t.cardType ?? null,
    t.orderId ?? null, t.merchantTxnId ?? null, t.billingCycleNumber ?? null, txnTypeOf(t) || null
  );
}

export async function persistTransactions(env, transactions, companyId = 1, mode = "missing") {
  if (transactions.length === 0) return;

  // AUTHORIZE/CAPTURE that carry a merchant_txn_id (the shared trxid) are reconciled by that
  // trxid through the overwrite state machine. Everything else — SALE, and any auth/capture
  // with no merchant_txn_id we can't pair — is deduped by cc_transaction_id as before.
  const independent = [];
  const authCapture = [];
  for (const t of transactions) {
    if (t.transactionId == null) continue;               // NOT NULL guard
    const type = txnTypeOf(t);
    if ((type === "AUTHORIZE" || type === "CAPTURE") && t.merchantTxnId) {
      authCapture.push(t);
    } else {
      // Blank billing cycle on a SALE always means cycle 1 (initial sale, preceded by soft
      // declines that never completed). Only SALE, never rebills (they carry a cycle ≥ 2).
      if (type === "SALE" && t.billingCycleNumber == null) t.billingCycleNumber = 1;
      independent.push(t);
    }
  }

  await persistIndependent(env, independent, companyId, mode);
  await reconcileAuthCapture(env, authCapture, companyId);
}

// Columns to refresh when overwriting an existing row (everything except the identity + created_at).
const TXN_UPSERT_SET = [
  "date_created", "response_type", "response_text", "merchant_id", "mid_number",
  "card_bin", "card_last4", "card_type", "order_id", "merchant_txn_id", "bill_cycle", "txn_type",
].map((c) => `${c} = excluded.${c}`).join(", ");

// SALE + anything not paired, deduped by cc_transaction_id.
//   mode "missing"   (default): INSERT OR IGNORE — existing rows untouched, only new ones added.
//   mode "overwrite":           upsert — refresh existing rows' fields with the latest pull. Use it
//                               to fix a bad/old import (we don't store chargeback/refund status,
//                               so there's little a stored sale row otherwise changes into).
// (The AUTHORIZE/CAPTURE reconcile below is unaffected by mode — a capture always wins over its auth.)
async function persistIndependent(env, transactions, companyId, mode = "missing") {
  if (transactions.length === 0) return;

  // dedup within this batch (keep the first row per cc_transaction_id)
  const seen = new Set();
  let rows = transactions.filter((t) => (seen.has(t.transactionId) ? false : (seen.add(t.transactionId), true)));

  if (mode !== "overwrite") {
    // update-missing: drop rows already stored (avoids re-binding them; OR IGNORE would skip anyway)
    const ids = [...seen];
    const existing = new Set();
    for (let i = 0; i < ids.length; i += LOOKUP_CHUNK) {
      const chunk = ids.slice(i, i + LOOKUP_CHUNK);
      const res = await env.DB.prepare(
        `SELECT cc_transaction_id FROM transactions WHERE company_id = ? AND cc_transaction_id IN (${chunk.map(() => "?").join(",")})`
      ).bind(companyId, ...chunk).all();
      for (const r of res.results ?? []) existing.add(r.cc_transaction_id);
    }
    rows = rows.filter((t) => !existing.has(t.transactionId));
  }
  if (rows.length === 0) return;

  const sql = mode === "overwrite"
    ? `INSERT INTO transactions (${TXN_INSERT_COLS}) VALUES (${TXN_INSERT_PLACEHOLDERS})
       ON CONFLICT(company_id, cc_transaction_id) DO UPDATE SET ${TXN_UPSERT_SET}`
    : `INSERT OR IGNORE INTO transactions (${TXN_INSERT_COLS}) VALUES (${TXN_INSERT_PLACEHOLDERS})`;
  const stmt = env.DB.prepare(sql);
  for (let i = 0; i < rows.length; i += PERSIST_CHUNK_SIZE) {
    await env.DB.batch(rows.slice(i, i + PERSIST_CHUNK_SIZE).map((t) => bindInsert(stmt, companyId, t)));
  }
}

// One incoming row folded onto the current state for a trxid. Returns the new state:
//   { kind:'db', id, ccId, type, success }  — the row already in the DB (no change), or
//   { kind:'row', type, success, row }      — an incoming row that should be written.
// Rules: CAPTURE is authoritative; AUTHORIZE-decline is final; never replace a CAPTURE with
// an AUTHORIZE.
function stepAuthCapture(state, inc) {
  const incType = txnTypeOf(inc);
  const asRow = { kind: "row", type: incType, success: isSuccess(inc.responseType), row: inc };
  if (!state) return asRow;                     // first row seen for this trxid
  if (incType === "AUTHORIZE") {
    if (state.type === "CAPTURE") return state;  // never replace a capture with an authorize
    return asRow;                                // authorize over authorize → latest wins
  }
  // incoming CAPTURE
  if (state.type === "CAPTURE") return asRow;    // newer capture wins (capture is authoritative)
  if (!state.success) return state;              // authorize DECLINE is final → ignore the capture
  return asRow;                                  // authorize SUCCESS → capture overwrites
}

// Sort a trxid's incoming rows chronologically so the fold sees auth before its capture.
function cmpAuthCapture(a, b) {
  const da = String(a.dateCreated ?? ""), db = String(b.dateCreated ?? "");
  if (da !== db) return da < db ? -1 : 1;
  const ta = txnTypeOf(a) === "AUTHORIZE" ? 0 : 1;
  const tb = txnTypeOf(b) === "AUTHORIZE" ? 0 : 1;
  if (ta !== tb) return ta - tb;
  return (a.transactionId ?? 0) - (b.transactionId ?? 0);
}

// AUTHORIZE/CAPTURE reconciliation, keyed by merchant_txn_id. Applies the state machine across
// what's already stored AND the incoming batch, then inserts new trxids / overwrites changed ones.
async function reconcileAuthCapture(env, rows, companyId) {
  if (rows.length === 0) return;

  // Current stored row per trxid (at most one; if legacy data has more, prefer the CAPTURE).
  const keys = [...new Set(rows.map((t) => t.merchantTxnId))];
  const existing = new Map();   // merchant_txn_id -> { id, ccId, type, success }
  for (let i = 0; i < keys.length; i += LOOKUP_CHUNK) {
    const chunk = keys.slice(i, i + LOOKUP_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const res = await env.DB.prepare(
      `SELECT id, cc_transaction_id, merchant_txn_id, txn_type, response_type FROM transactions
       WHERE company_id = ? AND txn_type IN ('AUTHORIZE','CAPTURE') AND merchant_txn_id IN (${placeholders})`
    ).bind(companyId, ...chunk).all();
    for (const r of res.results ?? []) {
      const cand = { id: r.id, ccId: r.cc_transaction_id, type: String(r.txn_type).toUpperCase(), success: isSuccess(r.response_type) };
      const cur = existing.get(r.merchant_txn_id);
      if (!cur || (cand.type === "CAPTURE" && cur.type !== "CAPTURE")) existing.set(r.merchant_txn_id, cand);
    }
  }

  const groups = new Map();
  for (const t of rows) {
    if (!groups.has(t.merchantTxnId)) groups.set(t.merchantTxnId, []);
    groups.get(t.merchantTxnId).push(t);
  }

  const toInsert = [];
  const toUpdate = [];   // { id, row }
  for (const [key, incoming] of groups) {
    incoming.sort(cmpAuthCapture);
    const ex = existing.get(key) || null;
    let state = ex ? { kind: "db", id: ex.id, ccId: ex.ccId, type: ex.type, success: ex.success } : null;
    for (const inc of incoming) state = stepAuthCapture(state, inc);

    if (state.kind === "db") continue;                        // winner is the stored row → no change
    if (ex && state.row.transactionId === ex.ccId) continue;  // same underlying row re-imported → no-op
    if (ex) toUpdate.push({ id: ex.id, row: state.row });     // overwrite the existing trxid row
    else toInsert.push(state.row);                            // brand-new trxid
  }

  if (toInsert.length) {
    const stmt = env.DB.prepare(`INSERT OR IGNORE INTO transactions (${TXN_INSERT_COLS}) VALUES (${TXN_INSERT_PLACEHOLDERS})`);
    for (let i = 0; i < toInsert.length; i += PERSIST_CHUNK_SIZE) {
      await env.DB.batch(toInsert.slice(i, i + PERSIST_CHUNK_SIZE).map((t) => bindInsert(stmt, companyId, t)));
    }
  }
  if (toUpdate.length) {
    // OR IGNORE: if the capture's cc_transaction_id already exists on another row, skip rather than throw.
    const upd = env.DB.prepare(
      `UPDATE OR IGNORE transactions SET
         cc_transaction_id = ?, date_created = ?, response_type = ?, response_text = ?,
         merchant_id = ?, mid_number = ?, card_bin = ?, card_last4 = ?, card_type = ?,
         order_id = ?, bill_cycle = ?, txn_type = ?
       WHERE id = ?`
    );
    for (let i = 0; i < toUpdate.length; i += PERSIST_CHUNK_SIZE) {
      await env.DB.batch(toUpdate.slice(i, i + PERSIST_CHUNK_SIZE).map(({ id, row: t }) =>
        upd.bind(
          t.transactionId, t.dateCreated, t.responseType, t.responseText ?? null,
          t.merchantId ?? null, t.midNumber ?? null, t.cardBin ?? null, t.cardLast4 ?? null, t.cardType ?? null,
          t.orderId ?? null, t.billingCycleNumber ?? null, txnTypeOf(t) || null, id
        )
      ));
    }
  }

  console.log(`[txn] auth/capture reconcile: ${groups.size} trxids → ${toInsert.length} inserted, ${toUpdate.length} overwritten`);
}

function toCheckoutChampDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [, year, month, day] = m;
  return `${parseInt(month, 10)}/${parseInt(day, 10)}/${year.slice(2)}`;
}
