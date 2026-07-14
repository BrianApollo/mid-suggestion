// lib/pipeline.js — pure funnel computation for Phase A preview. No DOM, no fetch.
// Shareable with the backend (same idea as compute.js). Given the grouped `combos`
// and the config, returns per-step in/out counts + per-noise-rule impact.
//
// combo: { merchant_id, response_type, response_text, card_type, count }
// A noise rule REMOVES a matching transaction (step polarity, per SPEC §6.1).

function matchOp(value, operator, ruleValue) {
  const v = value == null ? '' : String(value);
  switch (operator) {
    case 'is':         return v === ruleValue;
    case 'is_any_of':  return Array.isArray(ruleValue) && ruleValue.includes(v);
    case 'contains':   return v.includes(ruleValue);
    case 'starts_with':return v.startsWith(ruleValue);
    default:           return false;   // numeric/date ops don't apply to categorical combos
  }
}

// response_text carries a per-txn "REFID:<uid>" tail; strip it so a rule value picked from
// the (cleaned) options matches a raw row too. Combos arrive already cleaned by the backend;
// this makes matching idempotent + consistent across combos and raw rows. Keep in sync with
// `cleanText` in dev-stub/server.js.
export function normResponseText(v) {
  const s = v == null ? '' : String(v);
  const i = s.indexOf('REFID:');
  return (i > 0 ? s.slice(0, i) : s).trim();
}

function ruleMatches(combo, rule) {
  if (rule.scope && rule.scope !== 'ANY' && combo.response_type !== rule.scope) return false;
  const value = rule.field === 'response_text' ? normResponseText(combo[rule.field]) : combo[rule.field];
  return matchOp(value, rule.operator, rule.value);
}

const sum = (combos) => combos.reduce((s, c) => s + c.count, 0);

// The live filter only counts these response types (SPEC §6.1 outer OR); anything
// else (null/VOID/REFUND/…) is never countable, so the noise step must drop it too.
const COUNTABLE_TYPES = new Set(['SUCCESS', 'SOFT_DECLINE', 'HARD_DECLINE']);

// Would this single transaction row be COUNTED under `config`? (same rules as the funnel)
// row needs: merchant_id, response_type, response_text, card_type.
export function isCountable(row, config) {
  const A = config.phaseA;
  if (!A.mids.includes(Number(row.merchant_id))) return false;
  if (!COUNTABLE_TYPES.has(row.response_type)) return false;
  for (const rule of A.noise) if (rule.enabled && ruleMatches(row, rule)) return false;
  return true;
}

// Recency weight for a combo's age band. Each band (w1/m1/m3/m6/y1/old) carries a
// user-set multiplier; default 1 = no effect. Off → always 1.
export const AGE_BANDS = [
  { key: 'w1',  label: '≤ 1 week' },
  { key: 'm1',  label: '1 wk – 1 mo' },
  { key: 'm3',  label: '1 – 3 mo' },
  { key: 'm6',  label: '3 – 6 mo' },
  { key: 'y1',  label: '6 – 12 mo' },
  { key: 'old', label: '> 1 year' },
];
function makeRecencyWeight(recency) {
  if (!recency || !recency.enabled) return () => 1;
  const w = recency.weights || {};
  return (band) => (band && w[band] != null ? w[band] : 1);
}

// Recompute the whole banks×MIDs overview from fine-grained combos under `config` —
// the client-side equivalent of the backend's recompute. Pure.
// combo: { bank_id, mid_id, merchant_id, cyc, response_type, response_text, card_type, band, count }
// → [{ bankId, bankName, counts, scoreCounts }] where counts = raw (display) and
//   scoreCounts = recency-weighted (what the strategy scores on). Equal when recency is off.
export function aggregateOverview(combos, banks, mids, config) {
  const recency = config.strategy && config.strategy.recency;
  const useRecency = !!(recency && recency.enabled);
  const weightFor = makeRecencyWeight(recency);

  const rawByBank = new Map();
  const wByBank = useRecency ? new Map() : null;

  const add = (map, bankId, midId, cyc, key, amount) => {
    let bank = map.get(bankId);
    if (!bank) { bank = {}; map.set(bankId, bank); }
    let mc = bank[midId];
    if (!mc) { mc = { overall: { s: 0, f: 0 }, initial: { s: 0, f: 0 }, rebill: { s: 0, f: 0 } }; bank[midId] = mc; }
    mc.overall[key] += amount;
    if (cyc === 'initial') mc.initial[key] += amount;
    else if (cyc === 'rebill') mc.rebill[key] += amount;
  };

  for (const c of combos) {
    if (!isCountable(c, config)) continue;
    const key = c.response_type === 'SUCCESS' ? 's' : 'f';
    add(rawByBank, c.bank_id, c.mid_id, c.cyc, key, c.count);
    if (useRecency) add(wByBank, c.bank_id, c.mid_id, c.cyc, key, c.count * weightFor(c.band));
  }

  const nameById = new Map(banks.map((b) => [b.id, b.name]));
  return [...rawByBank.entries()]
    .map(([bankId, counts]) => ({
      bankId, bankName: nameById.get(bankId) || ('Bank ' + bankId),
      counts, scoreCounts: useRecency ? (wByBank.get(bankId) || counts) : counts,
    }))
    .sort((a, b) => {
      const tot = (x) => Object.values(x.counts).reduce((s, m) => s + m.overall.s + m.overall.f, 0);
      return tot(b) - tot(a) || a.bankName.localeCompare(b.bankName);
    });
}

export function runPipeline(combos, config) {
  const total = sum(combos);

  // Step 1 — intake (Sales only). The dataset is already Sale-only from ingestion,
  // so there's nothing to remove here; shown as a pass-through gate.
  const afterIntake = total;

  // Step 2 — which MIDs we track
  const midSet = new Set(config.phaseA.mids);
  const step2 = combos.filter((c) => midSet.has(c.merchant_id));
  const afterMids = sum(step2);

  // Step 3 — remove the noise
  const rules = config.phaseA.noise;
  const impacts = rules.map(() => 0);
  let removedUnion = 0;
  for (const combo of step2) {
    const countableType = COUNTABLE_TYPES.has(combo.response_type);
    let removed = !countableType;      // wrong response_type → never countable
    if (countableType) {
      for (let i = 0; i < rules.length; i++) {
        if (!rules[i].enabled) continue;
        if (ruleMatches(combo, rules[i])) {
          impacts[i] += combo.count;   // per-rule impact (independent; may overlap)
          removed = true;
        }
      }
    }
    if (removed) removedUnion += combo.count;   // union (what actually leaves)
  }
  const afterNoise = afterMids - removedUnion;

  return {
    total,
    counted: afterNoise,
    excluded: afterMids - afterNoise,
    steps: [
      { key: 'intake', in: total,       out: afterIntake, removed: total - afterIntake },
      { key: 'mids',   in: afterIntake, out: afterMids,   removed: afterIntake - afterMids },
      { key: 'noise',  in: afterMids,   out: afterNoise,  removed: removedUnion },
    ],
    noiseImpacts: impacts,   // aligned to config.phaseA.noise by index
  };
}
