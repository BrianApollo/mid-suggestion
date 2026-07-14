import { jsonResponse } from "../../lib/http.js";
import { applyCreds } from "../../lib/cc-client.js";

const PERSIST_CHUNK_SIZE = 100;
const CC_MAX_PAGE_SIZE = 500;
const MAX_PAGES = 1000;
const TIME_BUDGET_MS = 25_000;

// CheckoutChamp can't filter by more than one txnType per query, so we pull every type
// and keep only these in code. Values are matched case-insensitively against the row's
// txnType field — confirm the exact field name via the "page 1 sample keys" log below.
const ALLOWED_TXN_TYPES = new Set(["SALE", "AUTHORIZE", "CAPTURE"]);

export async function handleTransactions(request, env, url) {
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");

  if (!startDate || !endDate) {
    return jsonResponse(
      { error: "startDate and endDate are required (YYYY-MM-DD)" },
      { status: 400 }
    );
  }

  const startPage = Math.max(
    1,
    parseInt(url.searchParams.get("page") ?? "1", 10) || 1
  );

  const extraParams = {};
  for (const [k, v] of url.searchParams.entries()) {
    if (k === "startDate" || k === "endDate" || k === "page" || k === "resultsPerPage") continue;
    extraParams[k] = v;
  }

  const result = await ingestTransactions(env, {
    startDate,
    endDate,
    startPage,
    extraParams,
  });

  if (result.error) {
    return jsonResponse(
      {
        error: result.error,
        detail: result.detail,
        page: result.page,
        pagesProcessed: result.pagesProcessed,
        totalFetched: result.totalFetched,
        lastPage: result.lastPage,
      },
      { status: result.status ?? 502 }
    );
  }

  return jsonResponse({
    result: result.hasMore ? "PARTIAL" : "COMPLETE",
    startPage: result.startPage,
    lastPage: result.lastPage,
    pagesProcessed: result.pagesProcessed,
    totalFetched: result.totalFetched,
    hasMore: result.hasMore,
    nextPage: result.nextPage,
    endedReason: result.endedReason,
    message: result.hasMore
      ? `Time budget reached. Re-call with ?page=${result.nextPage}&startDate=${startDate}&endDate=${endDate} to continue.`
      : "Done. Call GET /api/recompute to rebuild bank_mid.",
  });
}

export async function ingestTransactions(
  env,
  { startDate, endDate, startPage = 1, timeBudgetMs = TIME_BUDGET_MS, extraParams = {}, companyId = 1, creds = {} }
) {
  const ccStart = toCheckoutChampDate(startDate);
  const ccEnd = toCheckoutChampDate(endDate);
  if (!ccStart || !ccEnd) {
    return { error: "invalid date format, expected YYYY-MM-DD", status: 400 };
  }

  if (!env.CC_PROXY) {
    return { error: "CC_PROXY service binding is not configured", status: 500 };
  }

  const upstream = new URL("https://proxy/transactions/query/");
  for (const [k, v] of Object.entries(extraParams)) {
    upstream.searchParams.set(k, v);
  }
  upstream.searchParams.set("startDate", ccStart);
  upstream.searchParams.set("endDate", ccEnd);
  // No txnType filter here — CC only accepts a single type per query, so we fetch all
  // types and filter to ALLOWED_TXN_TYPES in code (see fetchAndPersistPage).
  upstream.searchParams.set("resultsPerPage", String(CC_MAX_PAGE_SIZE));
  upstream.searchParams.set("exTestCards", true); // remove test cards
  upstream.searchParams.delete("responseType");
  applyCreds(upstream, creds); // inject this company's CheckoutChamp login/password (if stored)

  const startTime = Date.now();
  let pagesProcessed = 0;
  let totalFetched = 0;
  let lastPage = startPage - 1;
  let nextPage = null;
  let endedReason = "complete";
  let prevFirstId = null;
  let prevLastId = null;

  console.log(`[txn] starting at page ${startPage} (budget ${timeBudgetMs}ms)`);

  for (let page = startPage; page <= MAX_PAGES; page++) {
    const result = await fetchAndPersistPage(env, upstream, page, companyId);
    if (result.error) {
      return {
        error: result.error,
        detail: result.detail,
        page,
        pagesProcessed,
        totalFetched,
        lastPage,
        status: 502,
      };
    }
    pagesProcessed++;
    totalFetched += result.fetched;
    lastPage = page;

    if (result.fetched === 0) {
      endedReason = "empty page";
      break;
    }

    if (
      prevFirstId !== null &&
      result.firstId === prevFirstId &&
      result.lastId === prevLastId
    ) {
      console.warn(
        `[txn] pagination loop detected at page ${page} — CC returned same window as page ${page - 1}`
      );
      endedReason = `pagination loop at page ${page}`;
      break;
    }
    prevFirstId = result.firstId;
    prevLastId = result.lastId;

    if (page === MAX_PAGES) {
      endedReason = "MAX_PAGES";
      break;
    }

    const elapsed = Date.now() - startTime;
    if (elapsed > timeBudgetMs) {
      endedReason = `time budget (${elapsed}ms)`;
      nextPage = page + 1;
      break;
    }
  }

  const hasMore = nextPage !== null;
  console.log(
    `[txn] done — pages ${startPage}-${lastPage} (${pagesProcessed} pages, ${totalFetched} rows), reason: ${endedReason}`
  );

  return {
    startPage,
    lastPage,
    pagesProcessed,
    totalFetched,
    hasMore,
    nextPage,
    endedReason,
  };
}

async function fetchAndPersistPage(env, upstream, page, companyId = 1) {
  upstream.searchParams.set("page", String(page));
  console.log(`[txn] page ${page}: fetching from upstream`);

  let res;
  try {
    res = await env.CC_PROXY.fetch(upstream.toString(), {
      method: "POST",
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    return { error: "upstream request failed", detail: err.message, page };
  }

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      error: "non-JSON response from upstream",
      detail: text.slice(0, 200),
      page,
    };
  }

  const rows = extractTransactions(parsed);
  const firstId = rows[0]?.transactionId ?? null;
  const lastId = rows.at(-1)?.transactionId ?? null;
  console.log(
    `[txn] page ${page}: fetched ${rows.length} rows (first.id=${firstId ?? "—"} last.id=${lastId ?? "—"})`
  );

  if (page === 1 && rows.length > 0) {
    const s = rows[0];
    console.log(`[txn] page 1 sample keys: [${Object.keys(s).join(", ")}]`);
  }

  // Keep only the txnTypes we care about. Pagination/loop-detection above still uses the
  // RAW page (rows.length, firstId, lastId), so a page that filters down to 0 keeps paging.
  const toPersist = rows.filter((t) =>
    ALLOWED_TXN_TYPES.has(String(t.txnType ?? t.type ?? "").toUpperCase())
  );

  await persistTransactions(env, toPersist, companyId);
  console.log(`[txn] page ${page}: persisted ${toPersist.length}/${rows.length} (after txnType filter)`);

  return { page, fetched: rows.length, persisted: toPersist.length, firstId, lastId, raw: parsed };
}

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

export async function persistTransactions(env, transactions, companyId = 1) {
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

  await persistIndependent(env, independent, companyId);
  await reconcileAuthCapture(env, authCapture, companyId);
}

// SALE + anything not paired: dedup by cc_transaction_id, insert new rows only (never overwrite).
async function persistIndependent(env, transactions, companyId) {
  if (transactions.length === 0) return;

  const batchTxIds = [...new Set(transactions.map((t) => t.transactionId))];
  const existingTxIds = new Set();
  for (let i = 0; i < batchTxIds.length; i += LOOKUP_CHUNK) {
    const chunk = batchTxIds.slice(i, i + LOOKUP_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const res = await env.DB.prepare(
      `SELECT cc_transaction_id FROM transactions WHERE company_id = ? AND cc_transaction_id IN (${placeholders})`
    ).bind(companyId, ...chunk).all();
    for (const row of res.results ?? []) existingTxIds.add(row.cc_transaction_id);
  }

  const seen = new Set();
  const finalRows = transactions.filter((t) => {
    if (existingTxIds.has(t.transactionId) || seen.has(t.transactionId)) return false;
    seen.add(t.transactionId);
    return true;
  });
  if (finalRows.length === 0) return;

  const stmt = env.DB.prepare(`INSERT OR IGNORE INTO transactions (${TXN_INSERT_COLS}) VALUES (${TXN_INSERT_PLACEHOLDERS})`);
  for (let i = 0; i < finalRows.length; i += PERSIST_CHUNK_SIZE) {
    await env.DB.batch(finalRows.slice(i, i + PERSIST_CHUNK_SIZE).map((t) => bindInsert(stmt, companyId, t)));
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
