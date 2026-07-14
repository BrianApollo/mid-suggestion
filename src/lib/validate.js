// lib/validate.js — pure Publish validation (CONFIG-PLAN §9). No DOM, no fetch.
// validateConfig → BLOCK errors (config-only). configWarnings → non-blocking warnings
// (need a little data context). Messages are specific + actionable.

export function validateConfig(config) {
  const errors = [];
  const A = config.phaseA || {};
  const mids = A.mids || [];
  if (!mids.length) errors.push('Cannot publish — no MIDs selected (Pipeline → Which MIDs we track).');
  if (!(A.intake || []).length) errors.push('Cannot publish — no intake rule (Step 1, what comes in).');
  if (new Set(mids).size !== mids.length) errors.push('Cannot publish — the tracked MID list has a duplicate.');
  return errors;
}

// ctx (all optional): { excludedPct, merchantsWithData:Set, midIds:Set, bankIds:Set, midName(mid) }
export function configWarnings(config, ctx = {}) {
  const warnings = [];
  const A = config.phaseA || {};

  if (ctx.excludedPct != null && ctx.excludedPct > 0.95) {
    warnings.push('These rules would exclude ' + Math.round(ctx.excludedPct * 100) + '% of transactions — double-check before publishing.');
  }
  if (ctx.merchantsWithData) {
    for (const m of A.mids || []) {
      if (!ctx.merchantsWithData.has(m)) warnings.push('Tracked MID (merchant ' + m + ') has no transactions.');
    }
  }
  const name = ctx.midName || ((m) => 'MID ' + m);
  for (const o of config.overrides || []) {
    if (ctx.bankIds && !ctx.bankIds.has(o.bankId)) warnings.push('Override references a bank that has no data (bank ' + o.bankId + ').');
    const refMids = o.mode === 'split' ? Object.keys(o.config.weights || {}).map(Number) : (o.config && o.config.mid != null ? [o.config.mid] : []);
    for (const mid of refMids) {
      if (ctx.midIds && !ctx.midIds.has(mid)) warnings.push('Override references ' + name(mid) + ', but it isn\'t configured.');
    }
  }
  return warnings;
}
