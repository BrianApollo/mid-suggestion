# checkout-champ-proxy-mt

Multi-tenant duplicate of `checkout-champ-proxy`. **Identical except one thing:** it only injects
the default account's `loginId`/`password` when the caller **didn't** already pass its own.

## Why

The original proxy did this unconditionally:

```js
if (env.CC_USERNAME) upstreamURL.searchParams.set("loginId", env.CC_USERNAME);
if (env.CC_PASSWORD) upstreamURL.searchParams.set("password", env.CC_PASSWORD);
```

`.set()` **overwrites**, so any per-company `loginId`/`password` we passed was discarded and every
company got the **default account's** data (Accotta / `GeneralStoreApi`). That's why "Sync MIDs" for
a new company returned Accotta's merchants.

## The fix (worker.js)

```js
if (!upstreamURL.searchParams.has("loginId") && env.CC_USERNAME) upstreamURL.searchParams.set("loginId", env.CC_USERNAME);
if (!upstreamURL.searchParams.has("password") && env.CC_PASSWORD) upstreamURL.searchParams.set("password", env.CC_PASSWORD);
```

Now a company's own creds win; calls that pass none still fall back to the default account.
Fully backward-compatible (Accotta passes no creds → still uses the default).

## Deploy / wiring

1. Set the default account creds (`CC_USERNAME`/`CC_PASSWORD`) in `wrangler.jsonc` or as secrets.
2. `wrangler deploy`.
3. The **staging** worker (`mid-suggestion-dev`) binds `CC_PROXY` → this worker. The **live**
   worker still binds the original `checkout-champ-proxy`, so live is untouched.

> Brian: the cleanest long-term move is to apply this 2-line guard to the original
> `checkout-champ-proxy` and drop this duplicate — then both live + staging are multi-tenant.
