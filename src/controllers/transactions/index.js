import { jsonResponse } from "../../lib/http.js";
import { applyCreds } from "../../lib/cc-client.js";

const PERSIST_CHUNK_SIZE = 100;
const CC_MAX_PAGE_SIZE = 500;
const MAX_PAGES = 1000;
const TIME_BUDGET_MS = 25_000;

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
  upstream.searchParams.set("txnType", "SALE");
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

  await persistTransactions(env, rows, companyId);
  console.log(`[txn] page ${page}: persisted`);

  return { page, fetched: rows.length, firstId, lastId, raw: parsed };
}

function extractTransactions(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.message)) return parsed.message;
  if (Array.isArray(parsed?.data)) return parsed.data;
  if (Array.isArray(parsed?.message?.data)) return parsed.message.data;
  return [];
}

async function persistTransactions(env, transactions, companyId = 1) {
  if (transactions.length === 0) return;

  const batchTxIds = [...new Set(transactions.map((t) => t.transactionId))];

  const existingTxIds = new Set();
  if (batchTxIds.length > 0) {
    // D1 caps bound parameters at 100 per query; the `company_id = ?` bind takes one slot,
    // so keep the IN(...) list at 99 to stay at 100 total.
    const LOOKUP_CHUNK = 99;
    for (let i = 0; i < batchTxIds.length; i += LOOKUP_CHUNK) {
      const chunk = batchTxIds.slice(i, i + LOOKUP_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const res = await env.DB.prepare(
        `SELECT cc_transaction_id FROM transactions WHERE company_id = ? AND cc_transaction_id IN (${placeholders})`
      )
        .bind(companyId, ...chunk)
        .all();
      for (const row of res.results ?? []) {
        existingTxIds.add(row.cc_transaction_id);
      }
    }
  }

  const seenInBatch = new Set();
  const finalRows = transactions.filter((t) => {
    if (t.transactionId == null) return false;          // no id → would violate NOT NULL, skip
    if (existingTxIds.has(t.transactionId)) return false;
    if (seenInBatch.has(t.transactionId)) return false;
    seenInBatch.add(t.transactionId);
    return true;
  });

  if (finalRows.length !== transactions.length) {
    console.log(
      `[txn] persist: skipped ${transactions.length - finalRows.length} rows (cc_transaction_id duplicate)`
    );
  }

  if (finalRows.length === 0) return;

  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO transactions (
       company_id, cc_transaction_id, date_created, response_type, response_text,
       merchant_id, mid_number, card_bin, card_last4, card_type,
       order_id, merchant_txn_id, bill_cycle
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (let i = 0; i < finalRows.length; i += PERSIST_CHUNK_SIZE) {
    const chunk = finalRows.slice(i, i + PERSIST_CHUNK_SIZE).map((t) =>
      stmt.bind(
        companyId,
        t.transactionId,
        t.dateCreated,
        t.responseType,
        t.responseText ?? null,
        t.merchantId ?? null,
        t.midNumber ?? null,
        t.cardBin ?? null,
        t.cardLast4 ?? null,
        t.cardType ?? null,
        t.orderId ?? null,
        t.merchantTxnId ?? null,
        t.billingCycleNumber ?? null
      )
    );
    await env.DB.batch(chunk);
  }
}

function toCheckoutChampDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [, year, month, day] = m;
  return `${parseInt(month, 10)}/${parseInt(day, 10)}/${year.slice(2)}`;
}
