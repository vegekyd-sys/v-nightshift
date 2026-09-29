// A card in review waits for a human; its Agent execution has ended even
// though the native claim is retained until the reviewer decides. Production
// carried nine such cards, each silently taking one Night Shift slot.
const stoppedStatuses = new Set(["blocked", "done", "cancelled", "review"]);

export function activeCardCount(cards, now = Date.now()) {
  return cards.filter((card) => {
    if (card.status === "running" || card.execution?.status === "running") return true;
    // Native failure can retain a claim for recovery after execution has ended.
    // That reservation no longer consumes a running Agent slot.
    if (stoppedStatuses.has(card.status)) return false;
    const expiry = card.metadata?.claim?.expiresAt;
    const expiresAt = typeof expiry === "number" ? expiry : Date.parse(expiry ?? "");
    return Number.isFinite(expiresAt) && expiresAt > now;
  }).length;
}

// A card's first minutes are its heaviest on the agent database: the Session is
// built, context and Skills load, the first turns are written. On V
// (2026-09-29) 10 of 14 Night Shift runs cut by Agent DB lease timeouts were in
// their first 5 minutes, and the worst clusters followed 5 to 7 starts in 5
// minutes, while a start budget of 3 per 15 s allowed that. Starts therefore
// wait while too many cards are still warming up.
export function warmupAdmission(cards, { now = Date.now(), windowMs = 90_000, maxWarming = 3 } = {}) {
  const warmingSince = [];
  for (const card of cards) {
    if (!(card.status === "running" || card.execution?.status === "running")) continue;
    const startedAt = timestampMs(card.execution?.startedAt ?? card.startedAt);
    if (startedAt > 0 && now - startedAt < windowMs) warmingSince.push(startedAt);
  }
  warmingSince.sort((a, b) => a - b);
  const available = Math.max(0, maxWarming - warmingSince.length);
  // When full, the next start is possible once the oldest warming card is past its window.
  const retryAfterMs = available > 0 || warmingSince.length === 0 ? null
    : Math.max(1, warmingSince[warmingSince.length - maxWarming] + windowMs - now);
  return { warming: warmingSince.length, maxWarming, windowMs, available, retryAfterMs };
}

function timestampMs(value) {
  if (typeof value === "number") return value;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}
