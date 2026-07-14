// default-config.js — the config a brand-new company starts with. Generic card-decline
// noise filters + the Balanced strategy. `mids` starts empty and is filled from the
// company's own transactions on first ingest (POST /api/company/init).

export function defaultConfig() {
  return {
    version: 1,
    phaseA: {
      intake: [{ field: "type", operator: "is", value: "SALE", enabled: true, note: "Sales only" }],
      mids: [], // filled from their transactions after the first pull
      noise: [
        { scope: "ANY", field: "card_type", operator: "is", value: "TESTCARD", enabled: true, note: "test cards" },
        { scope: "SUCCESS", field: "response_text", operator: "is_any_of", value: ["Zero Amount Transaction Not Sent to Gateway"], enabled: true, note: "$0 validation call" },
        { scope: "SOFT_DECLINE", field: "response_text", operator: "starts_with", value: "CVV must be", enabled: true, note: "CVV format check" },
        { scope: "SOFT_DECLINE", field: "response_text", operator: "starts_with", value: "3DSecure is inactive", enabled: true, note: "3DS not enabled" },
        { scope: "SOFT_DECLINE", field: "response_text", operator: "is_any_of", enabled: true, note: "gateway / card-state noise", value: [
          "Insufficient funds", "Insufficient Funds", "CVV2 Mismatch", "Invalid CVV", "Invalid Cvc",
          "Pin tries exceeded", "Exceeds withdrawal limit", "Activity limit exceeded", "General error"] },
        { scope: "HARD_DECLINE", field: "response_text", operator: "is_any_of", enabled: true, note: "card-state / config noise", value: [
          "Account Closed", "Expired card", "Invalid card number", "Invalid transaction",
          "Transaction not permitted by issuer", "Re-enter transaction"] },
      ],
    },
    strategy: {
      name: "Balanced", weightInitial: 70, minAttempts: 25, gapPct: 5,
      tieAction: "prefer_rebill", floorPct: 0, explorePct: 0, noData: "global_best", defaultMid: null,
      recency: { enabled: false, weights: { w1: 1, m1: 1, m3: 1, m6: 1, y1: 1, old: 1 } },
    },
    overrides: [],
  };
}
