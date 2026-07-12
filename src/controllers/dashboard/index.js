import { jsonResponse } from "../../lib/http.js";
import { loadCompanyData, resolveCompanyId } from "../../lib/company-data.js";

// The read endpoints the routing dashboard UI calls. All tenant-scoped. Kept deliberately
// thin: each is one query (or a reuse of loadCompanyData) → JSON. No compute here — the UI
// does its own preview via the shared lib; the backend just serves the data.

const cleanText = (c) =>
  `rtrim(CASE WHEN instr(${c},'REFID:')>0 THEN substr(${c},1,instr(${c},'REFID:')-1) ELSE ${c} END)`;

const ROUTES = new Set([
  "/api/mids", "/api/banks", "/api/options", "/api/overview-combos",
  "/api/dataset", "/api/tables", "/api/transactions",
]);
handleDashboard.handles = (pathname) => ROUTES.has(pathname) || pathname.startsWith("/api/table/");

export async function handleDashboard(request, env, url) {
  const companyId = await resolveCompanyId(env, request, url);
  if (companyId == null) return jsonResponse({ error: "invalid api key" }, { status: 401 });
  const p = url.pathname;

  if (p === "/api/mids") {
    const rows = (await env.DB.prepare(
      "SELECT id, name, merchant_id FROM mids WHERE company_id = ? ORDER BY merchant_id"
    ).bind(companyId).all()).results ?? [];
    return jsonResponse(rows.map((r) => ({ id: r.id, merchantId: r.merchant_id, name: r.name })));
  }

  if (p === "/api/banks") {
    const rows = (await env.DB.prepare("SELECT id, name FROM banks ORDER BY name").all()).results ?? [];
    return jsonResponse(rows);
  }

  if (p === "/api/options") {
    const field = url.searchParams.get("field");
    if (field !== "response_text" && field !== "card_type") {
      return jsonResponse({ error: `unknown field '${field}'` }, { status: 400 });
    }
    const valExpr = field === "response_text" ? cleanText("response_text") : field;
    const rows = (await env.DB.prepare(
      `SELECT ${valExpr} AS value, COUNT(*) AS count FROM transactions
       WHERE company_id = ? AND ${field} IS NOT NULL AND ${field} != ''
       GROUP BY ${valExpr} ORDER BY count DESC LIMIT 500`
    ).bind(companyId).all()).results ?? [];
    return jsonResponse({ field, values: rows });
  }

  if (p === "/api/overview-combos") {
    const { combos, mids } = await loadCompanyData(env, companyId);
    const bankIds = new Set(combos.map((c) => c.bank_id));
    const banks = (await env.DB.prepare("SELECT id, name FROM banks").all()).results ?? [];
    return jsonResponse({ combos, banks: banks.filter((b) => bankIds.has(b.id)), mids });
  }

  if (p === "/api/dataset") {
    const rows = (await env.DB.prepare(
      `SELECT t.merchant_id AS merchant_id, t.response_type AS response_type,
              ${cleanText("t.response_text")} AS response_text, t.card_type AS card_type,
              COUNT(*) AS count
       FROM transactions t WHERE t.company_id = ?
       GROUP BY t.merchant_id, t.response_type, ${cleanText("t.response_text")}, t.card_type`
    ).bind(companyId).all()).results ?? [];
    return jsonResponse({ combos: rows });
  }

  if (p === "/api/tables") {
    const out = [];
    for (const [name, sql] of [
      ["banks", "SELECT COUNT(*) c FROM banks"],
      ["bins", "SELECT COUNT(*) c FROM bins"],
      ["mids", "SELECT COUNT(*) c FROM mids WHERE company_id = ?"],
      ["bank_mid", "SELECT COUNT(*) c FROM bank_mid WHERE company_id = ?"],
      ["transactions", "SELECT COUNT(*) c FROM transactions WHERE company_id = ?"],
    ]) {
      const scoped = sql.includes("?");
      const stmt = scoped ? env.DB.prepare(sql).bind(companyId) : env.DB.prepare(sql);
      out.push({ name, count: (await stmt.first()).c });
    }
    return jsonResponse(out);
  }

  if (p === "/api/transactions") {
    return browseTransactions(env, url, companyId);
  }

  if (p.startsWith("/api/table/")) {
    return browseTable(env, url, companyId, p.slice("/api/table/".length));
  }

  return jsonResponse({ error: "not found" }, { status: 404 });
}

// GET /api/transactions?page&limit&sort&dir&search — data browser (merchant name joined).
const TXN_SORTABLE = {
  date_created: "t.date_created", order_id: "t.order_id", card_bin: "t.card_bin",
  merchant_name: "m.name", response_type: "t.response_type", response_text: "t.response_text",
  bill_cycle: "t.bill_cycle", cc_transaction_id: "t.cc_transaction_id",
  merchant_txn_id: "t.merchant_txn_id", card_last4: "t.card_last4",
};
async function browseTransactions(env, url, companyId) {
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit"), 10) || 50));
  const page = Math.max(1, parseInt(url.searchParams.get("page"), 10) || 1);
  const search = (url.searchParams.get("search") || "").trim();
  const searchable = ["t.date_created", "t.order_id", "t.card_bin", "m.name", "t.response_type",
    "t.response_text", "t.bill_cycle", "t.cc_transaction_id", "t.merchant_txn_id", "t.card_last4"];

  let where = "WHERE t.company_id = ?";
  const params = [companyId];
  if (search) {
    where += " AND (" + searchable.map((c) => `CAST(${c} AS TEXT) LIKE ?`).join(" OR ") + ")";
    for (const _ of searchable) params.push(`%${search}%`);
  }
  const sortExpr = TXN_SORTABLE[url.searchParams.get("sort")] || null;
  const dir = url.searchParams.get("dir") === "desc" ? "DESC" : "ASC";
  const order = sortExpr ? `ORDER BY ${sortExpr} ${dir}` : "ORDER BY t.cc_transaction_id DESC";

  const from = `FROM transactions t LEFT JOIN mids m ON m.merchant_id = t.merchant_id AND m.company_id = t.company_id ${where}`;
  const total = (await env.DB.prepare(`SELECT COUNT(*) c ${from}`).bind(...params).first()).c;
  const rows = (await env.DB.prepare(
    `SELECT t.date_created, t.order_id, t.card_bin, t.merchant_id, m.name AS merchant_name, t.mid_number,
            t.response_type, t.response_text, t.card_type, t.bill_cycle,
            t.cc_transaction_id, t.merchant_txn_id, t.card_last4
     ${from} ${order} LIMIT ? OFFSET ?`
  ).bind(...params, limit, (page - 1) * limit).all()).results ?? [];
  return jsonResponse({ rows, page, limit, total, sort: url.searchParams.get("sort") || null, dir: dir.toLowerCase() });
}

// GET /api/table/:name — generic browser over banks/bins/mids/bank_mid (bank_mid → names).
const BROWSE_TABLES = ["banks", "bins", "mids", "bank_mid"];
async function browseTable(env, url, companyId, name) {
  if (!BROWSE_TABLES.includes(name)) return jsonResponse({ error: `unknown table '${name}'` }, { status: 400 });
  const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit"), 10) || 50));
  const page = Math.max(1, parseInt(url.searchParams.get("page"), 10) || 1);

  // per-company sources: bank_mid resolves ids→names; mids/bank_mid scope by company.
  const SOURCES = {
    bank_mid: {
      expr: `(SELECT b.name AS bank, m.name AS mid, bm.success_count, bm.fail_count
              FROM bank_mid bm LEFT JOIN banks b ON b.id = bm.bank_id
              LEFT JOIN mids m ON m.id = bm.mid_id
              WHERE bm.company_id = ?) AS sub`, params: [companyId],
    },
    mids: { expr: `(SELECT id, name, merchant_id FROM mids WHERE company_id = ?) AS sub`, params: [companyId] },
    banks: { expr: `"banks"`, params: [] },
    bins: { expr: `"bins"`, params: [] },
  };
  const { expr: source, params: baseParams } = SOURCES[name];

  const sample = (await env.DB.prepare(`SELECT * FROM ${source} LIMIT 1`).bind(...baseParams).all()).results ?? [];
  const columns = sample.length ? Object.keys(sample[0]) : [];

  const search = (url.searchParams.get("search") || "").trim();
  let where = "", searchParams = [];
  if (search && columns.length) {
    where = "WHERE (" + columns.map((c) => `CAST("${c}" AS TEXT) LIKE ?`).join(" OR ") + ")";
    searchParams = columns.map(() => `%${search}%`);
  }
  const sort = columns.includes(url.searchParams.get("sort")) ? url.searchParams.get("sort") : null;
  const dir = url.searchParams.get("dir") === "desc" ? "DESC" : "ASC";
  const order = sort ? `ORDER BY "${sort}" ${dir}` : "";

  const total = (await env.DB.prepare(`SELECT COUNT(*) c FROM ${source} ${where}`).bind(...baseParams, ...searchParams).first()).c;
  const rows = (await env.DB.prepare(`SELECT * FROM ${source} ${where} ${order} LIMIT ? OFFSET ?`)
    .bind(...baseParams, ...searchParams, limit, (page - 1) * limit).all()).results ?? [];
  return jsonResponse({ name, columns, rows, page, limit, total, sort, dir: dir.toLowerCase() });
}
