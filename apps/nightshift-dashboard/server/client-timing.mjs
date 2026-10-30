// One page load as the browser measured it, for the journal. Pages report how
// long until the board showed something (cached or fresh) and where the time
// went; `journalctl -u nightshift-workboard | grep client.load` reads them back.
const NUMBERS = ["htmlTtfb", "domReady", "overviewMs", "cachedPaint", "freshPaint"];

export function clientTimingEvent(body = {}) {
  const event = { event: "client.load" };
  for (const field of NUMBERS) {
    if (body[field] === null || body[field] === undefined || body[field] === "") continue;
    const value = Number(body[field]);
    if (Number.isFinite(value) && value >= 0 && value < 600_000) event[field] = Math.round(value);
  }
  if (event.freshPaint === undefined) throw Object.assign(new Error("freshPaint is required"), { statusCode: 400 });
  event.view = ["board", "workflows", "projects", "agents"].includes(body.view) ? body.view : "other";
  event.deepLink = body.deepLink === true;
  event.phone = body.phone === true;
  event.overviewCache = body.overviewCache === "cached" || body.overviewCache === "built" ? body.overviewCache : null;
  return event;
}
