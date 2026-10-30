import assert from "node:assert/strict";
import test from "node:test";
import { clientTimingEvent } from "./client-timing.mjs";

test("a page load report keeps only bounded numbers and known labels", () => {
  const event = clientTimingEvent({ htmlTtfb: 312.4, overviewMs: "880", freshPaint: 1210, cachedPaint: -1, view: "workflows", phone: true, overviewCache: "cached", extra: "x".repeat(10) });
  assert.deepEqual(event, { event: "client.load", htmlTtfb: 312, overviewMs: 880, freshPaint: 1210, view: "workflows", deepLink: false, phone: true, overviewCache: "cached" });
  assert.equal(clientTimingEvent({ freshPaint: 1, view: "<script>" }).view, "other");
  assert.throws(() => clientTimingEvent({ htmlTtfb: 1 }), /freshPaint/);
});
