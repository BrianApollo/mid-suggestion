import { jsonResponse } from "../../lib/http.js";
import { resolveCompanyId } from "../../lib/company-data.js";
import { testCheckoutChamp } from "../../lib/cc-client.js";

// GET /api/settings → the company's connection info (never returns the CC password).
export async function handleGetSettings(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });
  const c = await env.DB.prepare(
    "SELECT id, name, connected, cc_login, cc_password, last_ingest_at, last_tested_at, last_status FROM companies WHERE id = ?"
  ).bind(cid).first();
  if (!c) return jsonResponse({ error: "company not found" }, { status: 404 });
  return jsonResponse({
    companyId: c.id, name: c.name, connected: !!c.connected,
    ccLogin: c.cc_login || null, hasCcPassword: !!c.cc_password,
    lastIngestAt: c.last_ingest_at, lastTestedAt: c.last_tested_at, lastStatus: c.last_status,
    whitelistIp: env.WHITELIST_IP || null,
  });
}

// PUT /api/settings { name?, ccLogin?, ccPassword? } → save, then test + record connection status.
export async function handlePutSettings(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, { status: 400 }); }

  const sets = [], vals = [];
  if (typeof body.name === "string" && body.name.trim()) { sets.push("name = ?"); vals.push(body.name.trim()); }
  if (typeof body.ccLogin === "string") { sets.push("cc_login = ?"); vals.push(body.ccLogin.trim()); }
  if (typeof body.ccPassword === "string" && body.ccPassword) { sets.push("cc_password = ?"); vals.push(body.ccPassword); }
  if (sets.length) await env.DB.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, cid).run();

  const test = await recordTest(env, cid);
  return jsonResponse({ ok: true, connection: test });
}

// POST /api/settings/test → re-run the CheckoutChamp connection test (e.g. after whitelisting).
export async function handleTestConnection(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });
  return jsonResponse(await recordTest(env, cid));
}

async function recordTest(env, cid) {
  const c = await env.DB.prepare("SELECT cc_login, cc_password FROM companies WHERE id = ?").bind(cid).first();
  // Only the legacy company 1 (Accotta) may use the proxy's default creds; everyone else
  // must supply their own, or the proxy would pull Accotta's data.
  const test = (!c?.cc_login && cid !== 1)
    ? { status: "other", ok: false, detail: "No CheckoutChamp credentials set yet." }
    : await testCheckoutChamp(env, { login: c?.cc_login, password: c?.cc_password });
  await env.DB.prepare(
    "UPDATE companies SET connected = ?, last_tested_at = datetime('now'), last_status = ? WHERE id = ?"
  ).bind(test.ok ? 1 : 0, test.status, cid).run();
  return test;
}
