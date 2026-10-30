// Candidate entry: the terminal-attempt harness (private Gateway + dashboard
// server) running the overview cache scenario.
process.env.NIGHTSHIFT_HTTP_SCENARIO = "./overview-cache-http-scenario.mjs";
// Every forced refresh reads the board, so a changed card is seen at once.
process.env.NIGHTSHIFT_CARD_REFRESH_MIN_INTERVAL_MS = "1";
await import("./terminal-attempt.mjs");
