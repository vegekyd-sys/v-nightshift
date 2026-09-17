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
