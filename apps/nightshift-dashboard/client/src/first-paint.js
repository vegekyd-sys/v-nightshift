// Getting the board on screen fast: the requests index.html started before the
// app loaded, the last overview this browser saw (drawn at once, marked stale,
// replaced when the fresh one arrives), and one timing report per page load.
const CACHE_KEY = "nightshift.overview.live.v1";
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SAVE_EVERY_MS = 60_000;

function early() {
  return typeof window === "undefined" ? {} : (window.__nightshiftEarly ?? {});
}

// The live overview index.html already asked for, once.
export function takeEarlyOverview(scope) {
  const state = early();
  if (scope !== "live" || !state.overview) return null;
  const request = state.overview;
  state.overview = null;
  return request;
}

export function takeEarlyCard(cardId) {
  const state = early();
  if (!state.card || state.card.id !== cardId) return null;
  const request = state.card.request;
  state.card = null;
  return request.then((result) => result.body);
}

export function readCachedOverview(storage = globalThis.localStorage, now = Date.now()) {
  try {
    const saved = JSON.parse(storage.getItem(CACHE_KEY) ?? "null");
    if (!saved?.data || now - saved.savedAt > CACHE_MAX_AGE_MS) return null;
    return { ...saved.data, stale: true };
  } catch {
    return null;
  }
}

let lastSavedAt = null;
export function saveOverview(scope, data, storage = globalThis.localStorage, now = Date.now()) {
  if (scope !== "live" || !data || (lastSavedAt !== null && now - lastSavedAt < SAVE_EVERY_MS)) return;
  lastSavedAt = now;
  try {
    storage.setItem(CACHE_KEY, JSON.stringify({ savedAt: now, data }));
  } catch {
    // Full or blocked storage only costs the next visit its head start.
  }
}

export function resetSavedAtForTest() { lastSavedAt = null; }

let reported = false;
export function reportLoad({ view, cachedPaint = null, overviewCache = null, deepLink = false }) {
  if (reported || typeof window === "undefined") return;
  reported = true;
  const navigation = performance.getEntriesByType?.("navigation")?.[0];
  const overview = performance.getEntriesByType?.("resource")?.find((entry) => entry.name.includes("/api/overview"));
  const body = JSON.stringify({
    view,
    deepLink,
    phone: window.matchMedia?.("(max-width: 760px)").matches === true,
    htmlTtfb: navigation?.responseStart,
    domReady: navigation?.domContentLoadedEventEnd,
    overviewMs: overview ? overview.responseEnd - overview.startTime : undefined,
    cachedPaint,
    freshPaint: performance.now(),
    overviewCache,
  });
  try {
    if (!navigator.sendBeacon?.("/api/client-timing", body)) fetch("/api/client-timing", { method: "POST", body, keepalive: true }).catch(() => undefined);
  } catch {
    // Timing is best effort.
  }
}
