// Candidate entry: the terminal-attempt harness (private Gateway + dashboard
// server) running the operator commands scenario.
process.env.NIGHTSHIFT_HTTP_SCENARIO = "./operator-commands-http-scenario.mjs";
process.env.NIGHTSHIFT_CARD_REFRESH_MIN_INTERVAL_MS = "1";
await import("./terminal-attempt.mjs");
