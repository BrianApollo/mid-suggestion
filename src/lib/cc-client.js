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

  // Check explicit failures FIRST — CheckoutChamp often wraps errors in a 200 with an empty
  // data array, so we must not treat truthy [] as success.
  if (/invalid.*(login|user|credential)|incorrect.*(password|login)|login failed|not authori[sz]ed|unauthori[sz]ed|invalid api/.test(blob))
    return { status: "invalid_credentials", ok: false, detail: shortMsg(parsed) };
  if (/whitelist|ip address|not allowed|ip restrict|forbidden|access denied/.test(blob))
    return { status: "ip_not_whitelisted", ok: false, detail: shortMsg(parsed) };

  // Success: explicit SUCCESS, real data rows, or "no orders in range" (query ran → auth OK).
  const hasRows = (Array.isArray(parsed.message) && parsed.message.length) || (Array.isArray(parsed.data) && parsed.data.length);
  if (result === "SUCCESS" || hasRows || /no orders|no transaction|matching those parameters/.test(blob))
    return { status: "connected", ok: true };

  return { status: "other", ok: false, detail: shortMsg(parsed) || `result=${result}` };
}
