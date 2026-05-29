import { CORS_HEADERS } from "./lib/http.js";
import { handleSuggest } from "./controllers/suggest/index.js";
import {
  handleTransactions,
  ingestTransactions,
} from "./controllers/transactions/index.js";
import { handleRecompute } from "./controllers/recompute/index.js";
import { handleBinManagement } from "./controllers/bin-management/index.js";

// Cron ingest pulls a rolling window (yesterday + today, UTC) so late-settling
// transactions and timezone boundaries aren't missed. Dedup makes the overlap free.
const CRON_INGEST_WINDOW_DAYS = 1;
const CRON_MAX_CONTINUATIONS = 20;
const CRON_TIME_BUDGET_MS = 50_000;

function utcDateString(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/api/suggest" && request.method === "GET") {
      return handleSuggest(request, env, url);
    }

    if (url.pathname === "/api/transactions" && request.method === "GET") {
      return handleTransactions(request, env, url);
    }

    if (url.pathname === "/api/recompute" && request.method === "GET") {
      return handleRecompute(request, env, url);
    }

    if (url.pathname === "/api/bin-management" && request.method === "GET") {
      return handleBinManagement(request, env, url);
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },

  async scheduled(event, env, ctx) {
    const endDate = utcDateString(0);
    const startDate = utcDateString(-CRON_INGEST_WINDOW_DAYS);
    console.log(
      `[cron] transactions ingest ${startDate}..${endDate} (cron=${event.cron})`
    );

    let page = 1;
    let total = 0;
    for (let i = 0; i < CRON_MAX_CONTINUATIONS; i++) {
      const r = await ingestTransactions(env, {
        startDate,
        endDate,
        startPage: page,
        timeBudgetMs: CRON_TIME_BUDGET_MS,
      });
      if (r.error) {
        console.error(
          `[cron] ingest failed at page ${r.page ?? page}: ${r.error}${r.detail ? ` — ${r.detail}` : ""}`
        );
        return;
      }
      total += r.totalFetched;
      if (!r.hasMore) break;
      page = r.nextPage;
    }

    console.log(
      `[cron] transactions ingest complete — ${total} rows for ${startDate}..${endDate}`
    );
  },
};
