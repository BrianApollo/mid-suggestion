import { jsonResponse } from "../../lib/http.js";
import { resolveCompanyId } from "../../lib/company-data.js";
import { persistTransactions } from "../transactions/index.js";
import { createCsvParser, parseHeader, mapRow } from "./csv.js";

// CSV import of a CheckoutChamp "Transaction Details" export into the transactions table.
//   POST /api/import-excel?mode=missing|overwrite   — CSV as the raw request body (direct upload)
//   POST /api/import-r2?key=<obj>&mode=…            — CSV already sitting in the R2 bucket
//
// Both feed the SAME streaming engine (streamImport): the body is parsed incrementally and persisted
// in batches, so the whole file is never held in memory. Rows kept: Sale (initials) + Authorize /
// Capture (rebill attempt + settlement); Refund/Void skipped. The same persist path as the API sync
// runs — auth/capture reconcile, blank-cycle → 1, dedup — so it's identical data either way.
//
// NOTE: a direct POST is capped by Cloudflare's request-body limit (~100-500 MB by plan). The R2
// path has no such cap (upload straight to the bucket), but a file big enough to exceed one Worker
// invocation's time still needs the resumable/background version (TODO).

const PERSIST_BATCH = 2000;

// ── the shared streaming engine: consume a ReadableStream of CSV text, persist as we go ──
async function streamImport(env, stream, cid, mode) {
  let col = null, headerFound = false, fatal = null;
  let parsed = 0, eligible = 0, skippedType = 0, skippedInvalid = 0, sentToDb = 0;
  let batch = [];

  const flush = async () => {
    if (!batch.length) return;
    await persistTransactions(env, batch, cid, mode);
    sentToDb += batch.length;
    batch = [];
  };

  const onRow = (row) => {
    if (fatal) return;
    if (!headerFound) {
      const h = parseHeader(row);
      if (!h) return;                              // still in the preamble
      if (h.error) { fatal = h.error; return; }
      col = h.col; headerFound = true;
      return;
    }
    const m = mapRow(row, col);
    if (m.skip === "notxnid") return;
    parsed++;
    if (m.skip === "type") { skippedType++; return; }
    if (m.skip === "invalid") { skippedInvalid++; return; }
    eligible++;
    batch.push(m.txn);
  };

  const parser = createCsvParser();
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let first = true;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    let text = decoder.decode(value, { stream: true });
    if (first && text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    first = false;
    parser.feed(text, onRow);
    if (fatal) { try { await reader.cancel(); } catch (_) {} break; }
    if (batch.length >= PERSIST_BATCH) await flush();
  }
  if (!fatal) parser.finish(onRow);
  if (!fatal) await flush();

  return { fatal, headerFound, mode, parsed, eligible, imported: sentToDb, skippedNonSale: skippedType, skippedInvalid };
}

function respond(r) {
  if (r.fatal) return jsonResponse({ error: r.fatal }, { status: 400 });
  if (!r.headerFound) return jsonResponse({ error: "could not find the header row (expected a column named 'date')" }, { status: 400 });
  return jsonResponse({ ok: true, mode: r.mode, parsed: r.parsed, eligible: r.eligible, imported: r.imported, skippedNonSale: r.skippedNonSale, skippedInvalid: r.skippedInvalid });
}

// POST /api/import-excel — CSV in the raw request body.
export async function handleImportExcel(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });
  if (!request.body) return jsonResponse({ error: "empty body — POST the CSV export as the request body" }, { status: 400 });
  const mode = url.searchParams.get("mode") === "overwrite" ? "overwrite" : "missing";
  const r = await streamImport(env, request.body, cid, mode);
  console.log(`[import] company ${cid} — body mode=${mode} parsed=${r.parsed} eligible=${r.eligible} sentToDb=${r.imported}`);
  return respond(r);
}

// POST /api/import-r2?key=<object>&mode= — CSV already uploaded to the R2 bucket.
export async function handleImportR2(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });
  if (!env.CSV_BUCKET) return jsonResponse({ error: "R2 bucket not configured" }, { status: 500 });
  const key = url.searchParams.get("key");
  if (!key) return jsonResponse({ error: "key is required (?key=<object in the bucket>)" }, { status: 400 });
  const mode = url.searchParams.get("mode") === "overwrite" ? "overwrite" : "missing";

  const obj = await env.CSV_BUCKET.get(key);
  if (!obj) return jsonResponse({ error: `object not found in bucket: ${key}` }, { status: 404 });

  const r = await streamImport(env, obj.body, cid, mode);
  console.log(`[import] company ${cid} — r2 key=${key} mode=${mode} size=${obj.size} parsed=${r.parsed} eligible=${r.eligible} sentToDb=${r.imported}`);
  return respond({ ...r, key, size: obj.size });
}
