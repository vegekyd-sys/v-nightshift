import assert from "node:assert/strict";
import test from "node:test";
import { createCompletionUrlChecker } from "./completion-url.mjs";

const documentUrl = "https://tenant.feishu.cn/docx/Document123";

test("private document completion uses an authenticated exact-document read and expires its cache", async () => {
  let calls = 0;
  let time = 100;
  const env = { OPENCLAW_HOME: "/test/home" };
  const check = createCompletionUrlChecker({ env, now: () => time, runner: async (command, args, options) => {
    calls++;
    assert.equal(command, "lark-cli");
    assert.deepEqual(args.slice(0, 6), ["docs", "+fetch", "--doc", documentUrl, "--as", "user"]);
    assert.equal(options.env, env);
    assert.equal(options.timeout, 15000);
    return { stdout: JSON.stringify({ ok: true, documentId: "Document123" }) };
  }, fetchImpl: () => { throw new Error("Anonymous access cannot prove document access"); } });
  assert.equal(await check(documentUrl), true);
  assert.equal(await check(`${documentUrl}#section`), true);
  assert.equal(calls, 1);
  time += 30001;
  assert.equal(await check(documentUrl), true);
  assert.equal(calls, 2);
});

test("denied, malformed, or mismatched document reads cannot pass via a login page", async () => {
  for (const stdout of ['{"ok":false}', '{"ok":true,"documentId":"Other"}', "invalid JSON"]) {
    const check = createCompletionUrlChecker({ runner: async () => ({ stdout }), fetchImpl: async () => ({ ok: true }) });
    assert.equal(await check(documentUrl), false);
  }
  const check = createCompletionUrlChecker({ runner: async () => { throw new Error("auth unavailable"); }, fetchImpl: async () => ({ ok: true }) });
  assert.equal(await check(documentUrl), false);
});

test("ordinary URL validation keeps the HEAD fallback and never sends CLI credentials to lookalike hosts", async () => {
  const methods = [];
  let cancelled = false;
  const check = createCompletionUrlChecker({ runner: () => { throw new Error("Unexpected CLI call"); }, fetchImpl: async (url, options) => {
    methods.push(options.method ?? "GET");
    return options.method === "HEAD" ? { ok: false, status: 405 } : { ok: true, body: { cancel: async () => { cancelled = true; } } };
  } });
  assert.equal(await check("https://tenant.feishu.cn.example.org/docx/Document123"), true);
  assert.deepEqual(methods, ["HEAD", "GET"]);
  assert.ok(cancelled);
  assert.equal(await check("https://user:secret@tenant.feishu.cn/docx/Document123"), false);
});
