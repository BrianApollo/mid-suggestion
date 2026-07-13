import { jsonResponse } from "../../lib/http.js";
import { resolveCompanyId, hashString } from "../../lib/company-data.js";
import { ingestTransactions } from "../transactions/index.js";
import { recomputeCompany } from "../recompute/index.js";
import { queryMerchants } from "../../lib/cc-client.js";

const utcDate = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

// POST /api/ingest?page=N&startDate&endDate — pull ONE time-budgeted batch of this company's
// transactions (using their creds), tagged company_id. The UI loops page=nextPage until !hasMore,
// showing progress from totalStored. Defaults to the last year → today.
export async function handleCompanyIngest(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });

  const c = await env.DB.prepare("SELECT cc_login, cc_password FROM companies WHERE id = ?").bind(cid).first();
  // require own creds (except legacy company 1) — never fall through to the proxy default.
  if (!c?.cc_login && cid !== 1) {
    return jsonResponse({ error: "Connect CheckoutChamp first — no credentials stored." }, { status: 400 });
  }
  const startDate = url.searchParams.get("startDate") || utcDate(-365);
  const endDate = url.searchParams.get("endDate") || utcDate(0);
  const startPage = Math.max(1, parseInt(url.searchParams.get("page"), 10) || 1);

  const r = await ingestTransactions(env, {
    startDate, endDate, startPage, companyId: cid,
    creds: { login: c?.cc_login, password: c?.cc_password },
  });
  if (r.error) return jsonResponse(r, { status: r.status ?? 502 });
  if (!r.hasMore) await env.DB.prepare("UPDATE companies SET last_ingest_at = datetime('now') WHERE id = ?").bind(cid).run();

  const total = (await env.DB.prepare("SELECT COUNT(*) n FROM transactions WHERE company_id = ?").bind(cid).first()).n;
  return jsonResponse({ ...r, totalStored: total, startDate, endDate });
}

// POST /api/mids/sync — "Sync MIDs" button. Pull the company's merchants (MIDs) from
// CheckoutChamp (merchant/query/) through the proxy, using their creds, and upsert them into
// the `mids` table: billerId → merchant_id, title → name. Insert only when the billerId isn't
// already tracked for this company (idempotent — safe to re-run).
export async function handleSyncMids(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });

  const c = await env.DB.prepare("SELECT cc_login, cc_password FROM companies WHERE id = ?").bind(cid).first();
  // require own creds (except legacy company 1) — never fall through to the proxy default.
  if (!c?.cc_login && cid !== 1) {
    return jsonResponse({ error: "Connect CheckoutChamp first — no credentials stored." }, { status: 400 });
  }

  const result = await queryMerchants(env, { login: c?.cc_login, password: c?.cc_password });
  if (!result.ok) {
    return jsonResponse({ ok: false, status: result.status, error: "merchant query failed", detail: result.detail ?? null }, { status: 502 });
  }

  // CheckoutChamp nests the merchant list under message.data.
  const merchants = result.data?.message?.data ?? [];
  let inserted = 0, updated = 0, skipped = 0;
  for (const m of merchants) {
    if (m.billerId == null) continue;
    const enabled = m.enabled ? 1 : 0;
    const ex = await env.DB.prepare(
      "SELECT id, is_enabled FROM mids WHERE company_id = ? AND merchant_id = ?"
    ).bind(cid, m.billerId).first();
    if (ex) {
      // already tracked — leave the name, but keep the enabled flag current with CC.
      if (ex.is_enabled !== enabled) {
        await env.DB.prepare("UPDATE mids SET is_enabled = ? WHERE id = ?").bind(enabled, ex.id).run();
        updated++;
      } else {
        skipped++;
      }
      continue;
    }
    await env.DB.prepare("INSERT INTO mids (name, merchant_id, company_id, is_enabled) VALUES (?, ?, ?, ?)")
      .bind(m.title ?? `Merchant ${m.billerId}`, m.billerId, cid, enabled).run();
    inserted++;
  }

  console.log(`[mids] sync company ${cid} — ${merchants.length} from CC, ${inserted} inserted, ${updated} updated, ${skipped} unchanged`);
  return jsonResponse({ ok: true, total: merchants.length, inserted, updated, skipped });
}

// POST /api/company/init — after ingest: derive mids from their transactions, point the config's
// tracked-MID list at those merchant_ids, and recompute. Idempotent (safe to re-run).
export async function handleCompanyInit(request, env, url) {
  const cid = await resolveCompanyId(env, request, url);
  if (cid == null) return jsonResponse({ error: "not authenticated" }, { status: 401 });

  const rows = (await env.DB.prepare(
    "SELECT merchant_id, mid_number FROM transactions WHERE company_id = ? AND merchant_id IS NOT NULL GROUP BY merchant_id"
  ).bind(cid).all()).results ?? [];

  for (const r of rows) {
    const ex = await env.DB.prepare("SELECT id FROM mids WHERE company_id = ? AND merchant_id = ?").bind(cid, r.merchant_id).first();
    if (!ex) {
      await env.DB.prepare("INSERT INTO mids (name, merchant_id, company_id) VALUES (?, ?, ?)")
        .bind(r.mid_number || `Merchant ${r.merchant_id}`, r.merchant_id, cid).run();
    }
  }
  const merchantIds = rows.map((r) => r.merchant_id);

  const cfgRow = await env.DB.prepare(
    "SELECT config_json, version FROM config_versions WHERE company_id = ? AND is_current = 1"
  ).bind(cid).first();
  if (!cfgRow) return jsonResponse({ error: "no config for company" }, { status: 404 });

  const cfg = JSON.parse(cfgRow.config_json);
  cfg.phaseA.mids = merchantIds;
  await env.DB.prepare("UPDATE config_versions SET config_json = ?, phasea_hash = ? WHERE company_id = ? AND version = ?")
    .bind(JSON.stringify(cfg), hashString(JSON.stringify(cfg.phaseA)), cid, cfgRow.version).run();

  const rc = await recomputeCompany(env, cid, { ...cfg, version: cfgRow.version });
  if (rc.error) return jsonResponse({ ok: false, error: rc.error }, { status: 500 });
  return jsonResponse({ ok: true, mids: merchantIds.length, merchantIds, banksUpdated: rc.banksUpdated });
}
