// lib/compute.js — the ONE place with suggestion logic (see ARCHITECTURE.md §8).
// Pure: no DOM, no fetch. Designed so the Node backend can import the same file,
// so preview and live never disagree.
//
// A bank's `counts` is keyed by midId:
//   { [midId]: { overall:{s,f}, initial: {s,f}, rebill: {s,f} } }
// Scoring may run on recency-weighted counts (same shape); display always uses raw.

export const DEFAULT_STRATEGY = {
  name: 'Balanced',
  weightInitial: 70,        // rebill weight = 100 - this
  minAttempts: 25,          // ignore a MID below this many attempts on a bank
  gapPct: 5,                // top must beat #2 by more than this to be a "clear leader"
  tieAction: 'prefer_rebill', // when within the gap: top | prefer_rebill | prefer_initial | split
  floorPct: 0,              // 0 = off; never suggest a MID whose overall success % is below this
  explorePct: 0,            // 0 = off; else route this % of traffic to the runner-up (keep learning)
  noData: 'global_best',    // when a bank has no eligible MID: none | global_best | default
  defaultMid: null,         // MID to use when noData === 'default'
  // weight transactions by age band (applied in aggregateOverview); default 1 = no effect.
  recency: { enabled: false, weights: { w1: 1, m1: 1, m3: 1, m6: 1, y1: 1, old: 1 } },
};

// Named presets — set the knobs; the user can then tweak (which flips name to "Custom").
const noRecency = () => ({ enabled: false, weights: { w1: 1, m1: 1, m3: 1, m6: 1, y1: 1, old: 1 } });
export const PRESETS = {
  Safe:       { weightInitial: 60, minAttempts: 50, gapPct: 8, tieAction: 'prefer_rebill', floorPct: 70, explorePct: 0,  noData: 'global_best', recency: noRecency() },
  Balanced:   { weightInitial: 70, minAttempts: 25, gapPct: 5, tieAction: 'prefer_rebill', floorPct: 0,  explorePct: 0,  noData: 'global_best', recency: noRecency() },
  // Aggressive leans on recent data: recent bands up-weighted, anything over a year ignored.
  Aggressive: { weightInitial: 75, minAttempts: 10, gapPct: 3, tieAction: 'top',           floorPct: 0,  explorePct: 10, noData: 'global_best', recency: { enabled: true, weights: { w1: 2, m1: 1.5, m3: 1, m6: 1, y1: 0.75, old: 0 } } },
};

const rate = (cell) => {
  const t = cell.s + cell.f;
  return t ? cell.s / t : -1;
};
// count all filtered rows (overall), so banks whose rows have unknown bill_cycle
// still qualify against min-attempts instead of being wrongly excluded.
const attempts = (mc) => mc.overall.s + mc.overall.f;

function score(mc, wInitial) {
  const ri = rate(mc.initial), rr = rate(mc.rebill);
  if (ri < 0 && rr < 0) return rate(mc.overall);   // no known-cycle data → fall back to overall rate
  if (ri < 0) return rr;
  if (rr < 0) return ri;
  return wInitial * ri + (1 - wInitial) * rr;
}

// What to suggest when a bank has no MID with usable data.
function fallback(strategy, ctx) {
  if (strategy.noData === 'global_best' && ctx.globalBest != null)
    return { allocation: [{ mid: ctx.globalBest, pct: 100, fallback: true }], why: 'no data → global best' };
  if (strategy.noData === 'default' && strategy.defaultMid != null)
    return { allocation: [{ mid: strategy.defaultMid, pct: 100, fallback: true }], why: 'no data → default MID' };
  return { allocation: [], why: 'no data' };
}

// Returns { allocation: [{mid, pct}], why }
export function suggest(counts, mids, strategy = DEFAULT_STRATEGY, ctx = {}) {
  const w = strategy.weightInitial / 100;
  const minA = strategy.minAttempts;
  const gap = (strategy.gapPct ?? 5) / 100;
  const floor = (strategy.floorPct ?? 0) / 100;
  const explore = strategy.explorePct ?? 0;
  const tieAction = strategy.tieAction ?? 'top';

  let pool = mids.filter((m) => counts[m.id] && attempts(counts[m.id]) >= minA);
  if (!pool.length) pool = mids.filter((m) => counts[m.id]);   // relax the gate if nobody clears it

  let scored = pool
    .map((m) => ({ mid: m.id, sc: score(counts[m.id], w), c: counts[m.id] }))
    .filter((x) => x.sc >= 0)
    .sort((a, b) => b.sc - a.sc);

  // safety floor — drop MIDs whose overall success is below the floor, but only if
  // at least one MID survives (never leave a bank unrouted just because all are weak).
  if (floor > 0) {
    const kept = scored.filter((x) => rate(x.c.overall) >= floor);
    if (kept.length) scored = kept;
  }

  if (!scored.length) return fallback(strategy, ctx);
  if (scored.length === 1) return { allocation: [{ mid: scored[0].mid, pct: 100 }], why: 'only eligible' };

  const [top, second] = scored;
  let winner = top, why;
  if (top.sc - second.sc > gap) { why = 'clear leader'; }
  else if (tieAction === 'split') {
    return withExplore([{ mid: top.mid, pct: 50 }, { mid: second.mid, pct: 50 }], 'tie → split', explore, scored);
  } else if (tieAction === 'prefer_rebill') {
    winner = rate(top.c.rebill) >= rate(second.c.rebill) ? top : second; why = 'tie → higher rebill';
  } else if (tieAction === 'prefer_initial') {
    winner = rate(top.c.initial) >= rate(second.c.initial) ? top : second; why = 'tie → higher initial';
  } else { why = 'tie → top'; }

  return withExplore([{ mid: winner.mid, pct: 100 }], why, explore, scored);
}

// Carve an exploration slice to the best MID that isn't already the winner.
function withExplore(allocation, why, explorePct, scored) {
  if (!explorePct || allocation.length !== 1) return { allocation, why };
  const winnerMid = allocation[0].mid;
  const runnerUp = scored.find((x) => x.mid !== winnerMid);
  if (!runnerUp) return { allocation, why };
  return { allocation: [{ mid: winnerMid, pct: 100 - explorePct }, { mid: runnerUp.mid, pct: explorePct, explore: true }], why: why + ' + explore' };
}

// integer weights {midId:int} → [{mid, pct}] summing to 100 (drift added to the largest)
export function normalizeWeights(weights) {
  const entries = Object.entries(weights || {})
    .map(([mid, w]) => ({ mid: +mid, w: +w })).filter((e) => e.w > 0);
  const total = entries.reduce((s, e) => s + e.w, 0);
  if (!total) return [];
  const out = entries.map((e) => ({ mid: e.mid, pct: Math.round(e.w / total * 100) }));
  const drift = 100 - out.reduce((s, e) => s + e.pct, 0);
  if (drift) { out.sort((a, b) => b.pct - a.pct); out[0].pct += drift; }
  return out.sort((a, b) => b.pct - a.pct);
}

// The final routing allocation for a bank: strategy suggestion unless an override wins.
// Returns { allocation: [{mid, pct, pin?, test?, block?}], source, why }
export function allocate(counts, mids, strategy, override, ctx = {}) {
  if (override && override.mode === 'pin')
    return { allocation: [{ mid: override.config.mid, pct: 100, pin: true }], source: 'override:pin' };
  if (override && override.mode === 'split')
    return { allocation: normalizeWeights(override.config.weights), source: 'override:split' };
  if (override && override.mode === 'block') {
    // never suggest the blocked MID here — run the strategy on everything else.
    const allowed = mids.filter((m) => m.id !== override.config.mid);
    const s = suggest(counts, allowed, strategy, ctx);
    return { allocation: s.allocation, source: 'override:block', why: s.why };
  }
  if (override && override.mode === 'test') {
    const base = suggest(counts, mids, strategy, ctx);
    const baseMid = base.allocation[0] ? base.allocation[0].mid : null;
    const share = override.config.share || 15;
    const testMid = override.config.mid;
    if (baseMid == null || baseMid === testMid) {
      return { allocation: [{ mid: testMid, pct: 100, test: true }], source: 'override:test' };
    }
    return { allocation: [{ mid: baseMid, pct: 100 - share }, { mid: testMid, pct: share, test: true }], source: 'override:test' };
  }
  const s = suggest(counts, mids, strategy, ctx);
  return { allocation: s.allocation, source: 'strategy', why: s.why };
}

export const allocationKey = (alloc) =>
  (alloc || []).map((a) => a.mid + ':' + a.pct + (a.test ? 't' : '') + (a.explore ? 'e' : '')).join('|');
