/**
 * checkout-champ-proxy-mt — multi-tenant duplicate of checkout-champ-proxy.
 *
 * IDENTICAL to the original EXCEPT: it only injects the default account creds when the caller
 * DID NOT already pass its own loginId/password. This lets each company query CheckoutChamp
 * with its own credentials, while calls that pass nothing still fall back to the default account.
 *
 * Usage: hit with any CheckoutChamp endpoint path; query params, body and method are forwarded.
 */

const CC_DEFAULT_BASE = "https://api.checkoutchamp.com";

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204, env);
    }

    const proxySecret = env.PROXY_SECRET;
    if (proxySecret) {
      const incoming = request.headers.get("X-Proxy-Secret");
      if (incoming !== proxySecret) {
        return corsResponse(JSON.stringify({ error: "Unauthorized" }), 401, env);
      }
    }

    const base = (env.CC_BASE_URL || CC_DEFAULT_BASE).replace(/\/$/, "");
    const incoming = new URL(request.url);
    const upstreamURL = new URL(base + incoming.pathname + incoming.search);

    const forwardHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      const lower = key.toLowerCase();
      if (
        lower === "host" ||
        lower === "cf-connecting-ip" ||
        lower === "cf-ray" ||
        lower === "cf-ipcountry" ||
        lower === "cf-visitor" ||
        lower === "x-proxy-secret" ||
        lower === "x-forwarded-for"
      ) {
        continue;
      }
      forwardHeaders.set(key, value);
    }

    // ── Inject the DEFAULT account creds ONLY when the caller didn't pass its own ──
    // (the only change vs. the original — makes the proxy multi-tenant.)
    if (!upstreamURL.searchParams.has("loginId") && env.CC_USERNAME)
      upstreamURL.searchParams.set("loginId", env.CC_USERNAME);
    if (!upstreamURL.searchParams.has("password") && env.CC_PASSWORD)
      upstreamURL.searchParams.set("password", env.CC_PASSWORD);

    forwardHeaders.set("Accept", "application/json");

    let body = null;
    if (!["GET", "HEAD"].includes(request.method)) {
      body = await request.arrayBuffer();
      if (body.byteLength === 0) body = null;
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(upstreamURL.toString(), {
        method: request.method,
        headers: forwardHeaders,
        body,
      });
    } catch (err) {
      return corsResponse(
        JSON.stringify({ error: "Upstream request failed", detail: err.message }),
        502,
        env
      );
    }

    const responseHeaders = new Headers(upstreamResponse.headers);
    responseHeaders.set("Access-Control-Allow-Origin", corsOrigin(env));
    responseHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Proxy-Secret");
    responseHeaders.delete("transfer-encoding");
    responseHeaders.delete("connection");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  },
};

function corsOrigin(env) {
  return env.CORS_ORIGIN || "*";
}

function corsResponse(body, status, env) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": corsOrigin(env),
      "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Proxy-Secret",
    },
  });
}
