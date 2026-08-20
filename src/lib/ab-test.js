// ab-test.js — serve-time A/B split between the suggested MID and a test MID.
// Pure: no DOM, no fetch, no DB. Decides per call which MID to serve.
//
// `share` is the percentage of traffic to route to the test MID (0..100).
// We draw a random integer in [1, 100]:
//   - 1 .. (100 - share)        → serve the MID we're supposed to suggest
//   - (100 - share + 1) .. 100  → serve the test MID
//
// So share=0 always serves the suggested MID, share=100 always serves the test MID.
export function pickTestMid(suggestedMid, testMid, share) {
  const s = Math.max(0, Math.min(100, Number(share) || 0));
  const threshold = 100 - s;                       // upper bound of the "suggested" band
  const roll = Math.floor(Math.random() * 100) + 1; // random integer in [1, 100]
  return roll <= threshold ? suggestedMid : testMid;
}
