import { CORS_HEADERS, jsonResponse } from "./lib/http.js";
import { resolveCompanyId } from "./lib/company-data.js";
import { SyncDriver } from "./controllers/sync-driver/index.js";
import { handleSuggest } from "./controllers/suggest/index.js";
import { ingestTransactions } from "./controllers/transactions/index.js";
import { handleRecompute, recomputeBankMid } from "./controllers/recompute/index.js";
import { handleBinManagement } from "./controllers/bin-management/index.js";
import { handleGetConfig, handleGetVersions, handlePublish } from "./controllers/config/index.js";
import { handleDashboard } from "./controllers/dashboard/index.js";
import { handleSignup, handleLogin, handleMe } from "./controllers/auth/index.js";
import { handleGetSettings, handlePutSettings, handleTestConnection } from "./controllers/settings/index.js";
import { handleCompanyIngest, handleCompanyInit, handleSyncMids } from "./controllers/onboarding/index.js";
import { handleImportExcel, handleImportR2 } from "./controllers/import-excel/index.js";
import { handleUploadCreate, handleUploadPart, handleUploadComplete } from "./controllers/upload/index.js";

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

// ── background pull route handlers (delegate to the per-company SyncDriver DO) ──
async function handleSyncStart(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });
  const mode = url.searchParams.get("mode") === "overwrite" ? "overwrite" : "missing";
  const stub = env.SYNC_DRIVER.get(env.SYNC_DRIVER.idFromName("company:" + cid));

  // source=r2: process a CSV already uploaded to the bucket (walk-away big-file import).
  // Otherwise: the day-window CheckoutChamp API pull.
  let body;
  if (url.searchParams.get("source") === "r2") {
    const key = url.searchParams.get("key");
    if (!key) return jsonResponse({ error: "key is required for source=r2" }, { status: 400 });
    body = { source: "r2", companyId: cid, key, mode };
  } else {
    body = {
      companyId: cid,
      startDate: url.searchParams.get("startDate") || utcDateString(-365),
      endDate: url.searchParams.get("endDate") || utcDateString(0),
      mode,
    };
  }
  const resp = await stub.fetch("https://do/start", { method: "POST", body: JSON.stringify(body) });
  return jsonResponse(await resp.json());
}

async function handleSyncStatus(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });
  const stub = env.SYNC_DRIVER.get(env.SYNC_DRIVER.idFromName("company:" + cid));
  const resp = await stub.fetch("https://do/status");
  return jsonResponse(await resp.json());
}

// Poll the background publish/recompute job for a company (its own DO instance, "publish:<cid>").
async function handlePublishStatus(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });
  const stub = env.SYNC_DRIVER.get(env.SYNC_DRIVER.idFromName("publish:" + cid));
  const resp = await stub.fetch("https://do/status");
  return jsonResponse(await resp.json());
}

async function handleSyncCancel(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });
  const stub = env.SYNC_DRIVER.get(env.SYNC_DRIVER.idFromName("company:" + cid));
  const resp = await stub.fetch("https://do/cancel", { method: "POST" });
  return jsonResponse(await resp.json());
}

export { SyncDriver };

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
    if (url.pathname === "/api/mids/sync" && request.method === "POST") return handleSyncMids(request, env, url);
    if (url.pathname === "/api/import-excel" && request.method === "POST") return handleImportExcel(request, env, url);
    if (url.pathname === "/api/import-r2" && request.method === "POST") return handleImportR2(request, env, url);

    // ── R2 multipart upload (push a file of any size into the bucket past the ~100MB body cap) ──
    if (url.pathname === "/api/upload/create" && request.method === "POST") return handleUploadCreate(request, env, url);
    if (url.pathname === "/api/upload/part" && request.method === "PUT") return handleUploadPart(request, env, url);
    if (url.pathname === "/api/upload/complete" && request.method === "POST") return handleUploadComplete(request, env, url);

    // ── background pull (Durable Object driver): start once, close the tab, poll status ──
    if (url.pathname === "/api/sync/start" && request.method === "POST") return handleSyncStart(request, env, url);
    if (url.pathname === "/api/sync/status" && request.method === "GET") return handleSyncStatus(request, env, url);
    if (url.pathname === "/api/sync/cancel" && request.method === "POST") return handleSyncCancel(request, env, url);

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
    if (url.pathname === "/api/publish/status" && request.method === "GET") {
      return handlePublishStatus(request, env, url);
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

    // Per-company: pull each company that has its own CheckoutChamp creds, using those creds.
    // Company 1 is always included (legacy: on the single-tenant deploy it falls back to the
    // proxy's default account when it has no stored creds).
    const companies = (await env.DB.prepare(
      "SELECT id, cc_login, cc_password FROM companies WHERE id = 1 OR (cc_login IS NOT NULL AND cc_login != '')"
    ).all()).results ?? [];
    console.log(`[cron] transactions ingest ${startDate}..${endDate} for ${companies.length} companies (cron=${event.cron})`);

    for (const co of companies) {
      let fromDate = startDate;
      let total = 0;
      let done = false;
      for (let i = 0; i < CRON_MAX_CONTINUATIONS; i++) {
        const r = await ingestTransactions(env, {
          startDate,
          endDate,
          fromDate,
          timeBudgetMs: CRON_TIME_BUDGET_MS,
          companyId: co.id,
          creds: { login: co.cc_login, password: co.cc_password },
        });
        if (r.error) {
          console.error(`[cron] company ${co.id} ingest failed at ${r.nextDate ?? fromDate}: ${r.error}${r.detail ? ` — ${r.detail}` : ""}`);
          break;
        }
        total += r.totalFetched;
        if (!r.hasMore) { done = true; break; }
        fromDate = r.nextDate;
      }
      // Only stamp a pull that ran clean to the end of the window — a partial or failed
      // pull must not look like a fresh one. Same rule as the manual ingest path.
      // The dashboard reads this (/api/me, /api/settings) to show "last ingest".
      if (done) {
        await env.DB.prepare(
          "UPDATE companies SET last_ingest_at = datetime('now') WHERE id = ?"
        ).bind(co.id).run();
      }
      console.log(`[cron] company ${co.id} ingest — ${total} rows for ${startDate}..${endDate}`);
    }
  },
};
