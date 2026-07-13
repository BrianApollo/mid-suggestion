// cc-client.js — talk to CheckoutChamp through the CC_PROXY service binding, injecting a
// company's own loginId/password per call (so ingest + connection tests are per-company).

const toCcDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [, y, mo, d] = m;
  return `${+mo}/${+d}/${y.slice(2)}`;
};

// Put the company's creds onto a proxy URL (no-op when none — proxy falls back to its default).
export function applyCreds(url, creds) {
  if (creds && creds.login) url.searchParams.set("loginId", creds.login);
  if (creds && creds.password) url.searchParams.set("password", creds.password);
}

const shortMsg = (p) => {
  const m = p && (p.message ?? p.error ?? p.msg);
  return typeof m === "string" ? m.slice(0, 140) : "";
};

// One lightweight query → a plain connection status the UI can show.
export async function testCheckoutChamp(env, creds = {}) {
  if (!env.CC_PROXY) return { status: "unreachable", ok: false, detail: "CC_PROXY not configured" };

  const end = toCcDate(new Date().toISOString().slice(0, 10));
  const start = toCcDate(new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
  const url = new URL("https://proxy/transactions/query/");
  url.searchParams.set("startDate", start);
  url.searchParams.set("endDate", end);
  url.searchParams.set("resultsPerPage", "1");
  applyCreds(url, creds);

  let res, text;
  try {
    res = await env.CC_PROXY.fetch(url.toString(), { method: "POST", headers: { Accept: "application/json" } });
    text = await res.text();
  } catch (e) {
    return { status: "unreachable", ok: false, detail: e.message };
  }

  if (res.status === 401 || res.status === 403) {
    return { status: "ip_not_whitelisted", ok: false, detail: `HTTP ${res.status}` };
  }

  let parsed;
  try { parsed = JSON.parse(text); } catch { return { status: "other", ok: false, detail: text.slice(0, 140) }; }

  const result = String(parsed.result ?? parsed.status ?? "").toUpperCase();
  const blob = JSON.stringify(parsed).toLowerCase();

  // "no orders matching those parameters" = the query ran fine, just no data in range → auth OK.
  const authOk = result === "SUCCESS" || Array.isArray(parsed.message) || parsed.data
    || /no orders|no transaction|matching those parameters/.test(blob);
  if (authOk) return { status: "connected", ok: true };
  if (/login|credential|password|username|invalid.*user|auth/.test(blob)) return { status: "invalid_credentials", ok: false, detail: shortMsg(parsed) };
  if (/\bip\b|whitelist|not allowed|restrict|forbidden/.test(blob)) return { status: "ip_not_whitelisted", ok: false, detail: shortMsg(parsed) };
  return { status: "other", ok: false, detail: shortMsg(parsed) || `result=${result}` };
}
