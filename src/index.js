import { CORS_HEADERS } from "./lib/http.js";
import { handleSuggest } from "./controllers/suggest/index.js";
import {
  handleTransactions,
  ingestTransactions,
} from "./controllers/transactions/index.js";
import { handleRecompute, recomputeBankMid } from "./controllers/recompute/index.js";
import { handleBinManagement } from "./controllers/bin-management/index.js";
import { handleGetConfig, handleGetVersions, handlePublish } from "./controllers/config/index.js";
import { handleDashboard } from "./controllers/dashboard/index.js";
import { handleSignup, handleLogin, handleMe } from "./controllers/auth/index.js";
import { handleGetSettings, handlePutSettings, handleTestConnection } from "./controllers/settings/index.js";
import { handleCompanyIngest, handleCompanyInit } from "./controllers/onboarding/index.js";

// Cron ingest pulls a rolling window (yesterday + today, UTC) so late-settling
// transactions and timezone boundaries aren't missed. Dedup makes the overlap free.
const CRON_INGEST_WINDOW_DAYS = 1;
const CRON_MAX_CONTINUATIONS = 20;
const CRON_TIME_BUDGET_MS = 50_000;

// The recompute cron string must match wrangler.jsonc exactly.
const CRON_RECOMPUTE = "0 */12 * * *";

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

    // ── auth ──
    if (url.pathname === "/api/auth/signup" && request.method === "POST") return handleSignup(request, env);
    if (url.pathname === "/api/auth/login" && request.method === "POST") return handleLogin(request, env);
    if (url.pathname === "/api/me" && request.method === "GET") return handleMe(request, env);

    // ── settings / connection ──
    if (url.pathname === "/api/settings" && request.method === "GET") return handleGetSettings(request, env, url);
    if (url.pathname === "/api/settings" && request.method === "PUT") return handlePutSettings(request, env, url);
    if (url.pathname === "/api/settings/test" && request.method === "POST") return handleTestConnection(request, env, url);

    // ── onboarding: per-company ingest + init ──
    if (url.pathname === "/api/ingest" && request.method === "POST") return handleCompanyIngest(request, env, url);
    if (url.pathname === "/api/company/init" && request.method === "POST") return handleCompanyInit(request, env, url);

    // ── checkout serving (contract unchanged) ──
    if (url.pathname === "/api/suggest" && request.method === "GET") {
      return handleSuggest(request, env, url);
    }

    // ── dashboard config + publish ──
    if (url.pathname === "/api/config" && request.method === "GET") {
      return handleGetConfig(request, env, url);
    }
    if (url.pathname === "/api/config/versions" && request.method === "GET") {
      return handleGetVersions(request, env, url);
    }
    if (url.pathname === "/api/publish" && request.method === "POST") {
      return handlePublish(request, env, url);
    }

    // ── ingest (must come BEFORE the dashboard reads, which also own /api/transactions) ──
    // The ingest form carries ?startDate; the dashboard browser form does not.
    if (url.pathname === "/api/transactions" && request.method === "GET" && url.searchParams.has("startDate")) {
      return handleTransactions(request, env, url);
    }

    // ── dashboard reads (mids, banks, options, overview-combos, dataset, tables, transactions) ──
    if (url.pathname.startsWith("/api/") && request.method === "GET" && handleDashboard.handles(url.pathname)) {
      return handleDashboard(request, env, url);
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
    if (event.cron === CRON_RECOMPUTE) {
      console.log(`[cron] recompute (cron=${event.cron})`);
      const r = await recomputeBankMid(env);
      if (r.error) {
        console.error(`[cron] recompute failed: ${r.error}${r.detail ? ` — ${r.detail}` : ""}`);
      } else {
        console.log(
          `[cron] recompute done — rows=${r.newRows} Σsuccess=${r.totalSuccess} Σfail=${r.totalFail}`
        );
      }
      return;
    }

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
