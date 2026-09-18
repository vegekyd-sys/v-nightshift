import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { acceptsGzip, etagMatches, resetJsonCacheForTest, sendJson } from "./http-json.mjs";

// A bootstrap-shaped body: many cards with repeated keys, well above the gzip floor.
const bigBody = {
  cards: Array.from({ length: 400 }, (_, index) => ({
    id: `card-${index}`,
    status: index % 3 ? "queued" : "running",
    history: Array.from({ length: 5 }, (_, step) => ({ kind: "transition", fromStatus: "queued", toStatus: "running", at: step })),
  })),
};

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

test.beforeEach(() => resetJsonCacheForTest());

test("acceptsGzip reads the token list, not a substring", () => {
  assert.equal(acceptsGzip({ "accept-encoding": "gzip, br" }), true);
  assert.equal(acceptsGzip({ "accept-encoding": "br;q=1.0, gzip;q=0.8" }), true);
  assert.equal(acceptsGzip({ "accept-encoding": "identity" }), false);
  assert.equal(acceptsGzip({}), false);
});

test("etagMatches accepts weak, strong and list forms", () => {
  assert.equal(etagMatches('W/"abc"', 'W/"abc"'), true);
  assert.equal(etagMatches('"abc"', 'W/"abc"'), true);
  assert.equal(etagMatches('W/"x", W/"abc"', 'W/"abc"'), true);
  assert.equal(etagMatches('W/"other"', 'W/"abc"'), false);
  assert.equal(etagMatches(undefined, 'W/"abc"'), false);
});

test("a large JSON body is gzip-encoded when the client accepts it", async () => {
  await withServer((request, response) => sendJson(request, response, 200, bigBody), async (base) => {
    const response = await fetch(`${base}/`, { headers: { "accept-encoding": "gzip, br" } });
    assert.equal(response.status, 200);
    // undici transparently decodes; check what the wire carried via the headers.
    assert.equal(response.headers.get("content-encoding"), "gzip");
    assert.equal(response.headers.get("vary"), "Accept-Encoding");
    assert.equal(response.headers.get("cache-control"), "no-store");
    const decoded = await response.json();
    assert.equal(decoded.cards.length, 400);
    const raw = Buffer.byteLength(JSON.stringify(bigBody));
    const wire = Number(response.headers.get("content-length"));
    assert.ok(wire < raw / 4, `expected gzip to shrink ${raw} bytes well below a quarter, got ${wire}`);
  });
});

test("identity encoding is used when the client does not accept gzip", async () => {
  await withServer((request, response) => sendJson(request, response, 200, bigBody), async (base) => {
    const response = await fetch(`${base}/`, { headers: { "accept-encoding": "identity" } });
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(Number(response.headers.get("content-length")), Buffer.byteLength(JSON.stringify(bigBody)));
    const decoded = await response.json();
    assert.equal(decoded.cards.length, 400);
  });
});

test("small bodies are sent raw even when gzip is accepted", async () => {
  await withServer((request, response) => sendJson(request, response, 200, { ok: true }), async (base) => {
    const response = await fetch(`${base}/`, { headers: { "accept-encoding": "gzip" } });
    assert.equal(response.headers.get("content-encoding"), null);
    assert.deepEqual(await response.json(), { ok: true });
  });
});

test("revalidate responses carry an ETag and answer If-None-Match with 304 and no body", async () => {
  await withServer((request, response) => sendJson(request, response, 200, bigBody, { revalidate: true }), async (base) => {
    const first = await fetch(`${base}/`, { headers: { "accept-encoding": "gzip" } });
    const etag = first.headers.get("etag");
    assert.match(etag, /^W\/"/);
    assert.equal(first.headers.get("cache-control"), "no-cache");
    await first.arrayBuffer();

    const second = await fetch(`${base}/`, { headers: { "accept-encoding": "gzip", "if-none-match": etag } });
    assert.equal(second.status, 304);
    assert.equal(second.headers.get("etag"), etag);
    assert.equal((await second.arrayBuffer()).byteLength, 0);

    const changed = await fetch(`${base}/`, { headers: { "accept-encoding": "gzip", "if-none-match": 'W/"stale"' } });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).cards.length, 400);
  });
});

test("the same body is compressed once and served from the cache to later polls", async () => {
  let calls = 0;
  const { gzipSync } = await import("node:zlib");
  const expected = gzipSync(Buffer.from(JSON.stringify(bigBody)), { level: 6 });
  await withServer((request, response) => { calls += 1; sendJson(request, response, 200, bigBody, { revalidate: true }); }, async (base) => {
    for (let index = 0; index < 3; index += 1) {
      const response = await fetch(`${base}/`, { headers: { "accept-encoding": "gzip" } });
      assert.equal(Number(response.headers.get("content-length")), expected.length);
      // fetch decodes gzip transparently: the wire length is Content-Length,
      // the decoded length is what arrayBuffer() hands back.
      const decoded = await response.arrayBuffer();
      assert.equal(decoded.byteLength, Buffer.byteLength(JSON.stringify(bigBody)));
    }
    assert.equal(calls, 3);
  });
});

test("non-200 statuses never get an ETag or a 304", async () => {
  await withServer((request, response) => sendJson(request, response, 404, { error: "missing" }, { revalidate: true }), async (base) => {
    const response = await fetch(`${base}/`, { headers: { "if-none-match": "*" } });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("etag"), null);
  });
});
