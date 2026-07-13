import { jsonResponse } from "../../lib/http.js";
import { hashPassword, verifyPassword, signToken } from "../../lib/auth.js";
import { authPayload, hashString } from "../../lib/company-data.js";
import { defaultConfig } from "../../lib/default-config.js";

const secret = (env) => env.AUTH_SECRET || "staging-fallback-secret-change-me";

// POST /api/auth/signup { email, password, companyName }
export async function handleSignup(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, { status: 400 }); }
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  const companyName = String(body.companyName || body.company || "").trim();
  if (!email || !password || !companyName) {
    return jsonResponse({ error: "email, password and companyName are required" }, { status: 400 });
  }
  const exists = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
  if (exists) return jsonResponse({ error: "an account with this email already exists" }, { status: 409 });

  const apiKey = crypto.randomUUID();
  const compRes = await env.DB.prepare(
    "INSERT INTO companies (name, api_key, connected) VALUES (?, ?, 0)"
  ).bind(companyName, apiKey).run();
  const companyId = compRes.meta.last_row_id;

  const pw = await hashPassword(password);
  const userRes = await env.DB.prepare(
    "INSERT INTO users (email, password_hash, company_id) VALUES (?, ?, ?)"
  ).bind(email, pw, companyId).run();
  const uid = userRes.meta.last_row_id;

  const cfg = defaultConfig();
  await env.DB.prepare(
    "INSERT INTO config_versions (company_id, version, config_json, phasea_hash, is_current, published_by) VALUES (?, 1, ?, ?, 1, ?)"
  ).bind(companyId, JSON.stringify(cfg), hashString(JSON.stringify(cfg.phaseA)), email).run();

  const token = await signToken({ uid, cid: companyId }, secret(env));
  return jsonResponse({ token, user: { id: uid, companyId, name: companyName } });
}

// POST /api/auth/login { email, password }
export async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, { status: 400 }); }
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  const user = await env.DB.prepare(
    "SELECT u.id, u.password_hash, u.company_id, c.name FROM users u JOIN companies c ON c.id = u.company_id WHERE u.email = ?"
  ).bind(email).first();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return jsonResponse({ error: "invalid email or password" }, { status: 401 });
  }
  const token = await signToken({ uid: user.id, cid: user.company_id }, secret(env));
  return jsonResponse({ token, user: { id: user.id, companyId: user.company_id, name: user.name } });
}

// GET /api/me → who am I + connection state
export async function handleMe(request, env) {
  const payload = await authPayload(request, env);
  if (!payload || payload.cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });
  const c = await env.DB.prepare(
    "SELECT id, name, connected, last_ingest_at, last_status FROM companies WHERE id = ?"
  ).bind(payload.cid).first();
  if (!c) return jsonResponse({ error: "company not found" }, { status: 404 });
  return jsonResponse({
    companyId: c.id, name: c.name, connected: !!c.connected,
    lastIngestAt: c.last_ingest_at, lastStatus: c.last_status,
  });
}
