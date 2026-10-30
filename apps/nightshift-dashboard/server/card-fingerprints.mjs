import { createHash } from "node:crypto";

// Tells whether a card refresh changed the board. The Workboard is read for
// ~20 cards every few seconds, and this used to hash the JSON of the whole
// cache each time: 12,337 cards / 220 MB on V (2026-10-30), a second or more
// of blocked event loop per read. Only the cards a read returned or dropped
// are fingerprinted now.
export class CardFingerprints {
  byId = new Map();

  // A full read: `cards` is the whole board.
  replaceAll(cards) {
    const next = new Map(cards.map((card) => [card.id, fingerprint(card)]));
    const changed = next.size !== this.byId.size || [...next].some(([id, value]) => this.byId.get(id) !== value);
    this.byId = next;
    return changed;
  }

  // A scoped read: `requestedIds` were asked for and `cards` came back; an id
  // asked for and not returned is gone from the board.
  replaceSome(requestedIds, cards) {
    let changed = false;
    const returned = new Set();
    for (const card of cards) {
      returned.add(card.id);
      const value = fingerprint(card);
      if (this.byId.get(card.id) !== value) changed = true;
      this.byId.set(card.id, value);
    }
    for (const id of requestedIds) {
      if (returned.has(id) || !this.byId.has(id)) continue;
      this.byId.delete(id);
      changed = true;
    }
    return changed;
  }
}

function fingerprint(card) {
  return createHash("sha1").update(JSON.stringify(card)).digest("base64url");
}
