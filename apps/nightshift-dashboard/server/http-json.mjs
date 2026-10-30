import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

// Bodies below this size are cheaper to send raw than to compress.
const GZIP_MIN_BYTES = 1024;
// The Live Board polls the same bootstrap from several browsers every 10s; keep
// the last few compressed bodies so one change is compressed once, not per poll.
const GZIP_CACHE_LIMIT = 8;
const gzipCache = new Map();

export function acceptsGzip(headers) {
  const accept = String(headers?.["accept-encoding"] ?? "");
  return accept
    .split(",")
    .some((token) => token.trim().split(";")[0].trim().toLowerCase() === "gzip");
}

export function etagFor(body) {
  return `W/"${createHash("sha1").update(body).digest("base64url")}"`;
}

export function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  return ifNoneMatch
    .split(",")
    .map((token) => token.trim())
    .some((token) => token === etag || token === etag.replace(/^W\//, "") || `W/${token}` === etag);
}

function gzipCached(etag, body) {
  const hit = gzipCache.get(etag);
  if (hit) return hit;
  const compressed = gzipSync(body, { level: 6 });
  gzipCache.set(etag, compressed);
  if (gzipCache.size > GZIP_CACHE_LIMIT) gzipCache.delete(gzipCache.keys().next().value);
  return compressed;
}

/**
 * Serialize `value` as JSON and send it honouring the client's Accept-Encoding
 * and, when `revalidate` is set, its If-None-Match.
 *
 * Default responses stay `no-store` like before. `revalidate: true` switches to
 * `no-cache` + ETag so a browser re-polling an unchanged body gets a 304 with no
 * payload instead of the full document again.
 */
export function sendJson(request, response, status, value, { revalidate = false, headers: extraHeaders = {} } = {}) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const headers = {
    ...extraHeaders,
    "Cache-Control": revalidate ? "no-cache" : "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
  let etag;
  if (revalidate && status === 200) {
    etag = etagFor(body);
    headers.ETag = etag;
    if (etagMatches(request?.headers?.["if-none-match"], etag)) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
  }
  if (body.length >= GZIP_MIN_BYTES && acceptsGzip(request?.headers)) {
    const compressed = gzipCached(etag ?? etagFor(body), body);
    response.writeHead(status, {
      ...headers,
      "Content-Encoding": "gzip",
      "Content-Length": compressed.length,
      Vary: "Accept-Encoding",
    });
    response.end(compressed);
    return;
  }
  response.writeHead(status, { ...headers, "Content-Length": body.length, Vary: "Accept-Encoding" });
  response.end(body);
}

export function resetJsonCacheForTest() {
  gzipCache.clear();
}
