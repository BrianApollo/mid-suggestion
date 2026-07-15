import { jsonResponse } from "../../lib/http.js";
import { validateConfig } from "../../lib/validate.js";
import { loadCurrentConfig, resolveCompanyId, hashString } from "../../lib/company-data.js";

// GET /api/config → the company's current published config (404 if none yet).
export async function handleGetConfig(request, env, url) {
  const companyId = await resolveCompanyId(env, request, url);
  if (companyId == null) return jsonResponse({ error: "invalid api key" }, { status: 401 });
  const config = await loadCurrentConfig(env, companyId);
  if (!config) return jsonResponse({ error: "no config for this company", companyId }, { status: 404 });
  return jsonResponse(config);
}

// GET /api/config/versions → the version history.
export async function handleGetVersions(request, env, url) {
  const companyId = await resolveCompanyId(env, request, url);
  if (companyId == null) return jsonResponse({ error: "invalid api key" }, { status: 401 });
  const rows = (await env.DB.prepare(
    "SELECT version, published_by, published_at, is_current FROM config_versions WHERE company_id = ? ORDER BY version DESC"
  ).bind(companyId).all()).results ?? [];
  return jsonResponse({ companyId, versions: rows });
}

// POST /api/publish { config } → validate → store a new version → recompute suggestions.
export async function handlePublish(request, env, url) {
  const companyId = await resolveCompanyId(env, request, url);
  if (companyId == null) return jsonResponse({ error: "invalid api key" }, { status: 401 });

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid JSON body" }, { status: 400 }); }
  const config = body.config || body;

  const errors = validateConfig(config);
  if (errors.length) return jsonResponse({ error: errors[0], errors }, { status: 400 });

  const phaseaHash = hashString(JSON.stringify(config.phaseA || {}));
  const prev = await env.DB.prepare(
    "SELECT MAX(version) AS v FROM config_versions WHERE company_id = ?"
  ).bind(companyId).first();
  const version = (prev?.v ?? 0) + 1;

  // Store the new version as NOT current, then run the (potentially slow) recompute IN THE
  // BACKGROUND via the per-company publish DO. The DO flips `is_current` to this version only
  // AFTER a successful recompute — so a failed publish never leaves a live-but-broken config,
  // and this request returns instantly. The UI polls /api/publish/status until it's done.
  await env.DB.prepare(
    "INSERT INTO config_versions (company_id, version, config_json, phasea_hash, is_current, published_by) VALUES (?, ?, ?, ?, 0, ?)"
  ).bind(companyId, version, JSON.stringify(config), phaseaHash, body.publishedBy ?? null).run();

  const stub = env.SYNC_DRIVER.get(env.SYNC_DRIVER.idFromName("publish:" + companyId));
  await stub.fetch("https://do/start", {
    method: "POST",
    body: JSON.stringify({ source: "recompute", companyId, version }),
  });

  return jsonResponse({ ok: true, recomputing: true, version });
}
