export function createSessionReader({
  getSession,
  maxEntries = 200,
  maxStartsPerWindow = 1,
  now = Date.now,
  runningTtlMs = 30_000,
  startWindowMs = 30_000,
}) {
  if (typeof getSession !== "function") throw new Error("getSession is required");
  const cache = new Map();
  const inFlight = new Map();
  let starts = [];

  return async function readSession({ cacheKey, limit, sessionKey, terminal = false }) {
    const current = cache.get(cacheKey);
    const timestamp = now();
    if (current && (current.terminal || timestamp - current.loadedAt < runningTtlMs)) return current.value;
    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
    starts = starts.filter((startedAt) => startedAt > timestamp - startWindowMs);
    if (starts.length >= maxStartsPerWindow) {
      if (current) return current.value;
      const error = new Error("Session detail refresh is rate limited; retry shortly");
      error.statusCode = 429;
      throw error;
    }
    starts.push(timestamp);
    const request = Promise.resolve(getSession(sessionKey, { limit }))
      .then((value) => {
        cache.delete(cacheKey);
        cache.set(cacheKey, { loadedAt: now(), terminal, value });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        return value;
      })
      .finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, request);
    return request;
  };
}
