export function createSessionReader({ getSession, maxEntries = 200, now = Date.now, runningTtlMs = 30_000 }) {
  if (typeof getSession !== "function") throw new Error("getSession is required");
  const cache = new Map();
  const inFlight = new Map();

  return async function readSession({ cacheKey, limit, sessionKey, terminal = false }) {
    const current = cache.get(cacheKey);
    const timestamp = now();
    if (current && (current.terminal || timestamp - current.loadedAt < runningTtlMs)) return current.value;
    if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
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
