import assert from "node:assert/strict";
import test from "node:test";
import { createPublicAuth, requiresPublicAuth, verifyPublicAuth } from "./public-auth.mjs";

test("public auth applies only to the declared hostname", () => {
  assert.equal(requiresPublicAuth({ headers: { host: "nightshift.tianyi.live" } }, "nightshift.tianyi.live"), true);
  assert.equal(requiresPublicAuth({ headers: { host: "127.0.0.1:24879" } }, "nightshift.tianyi.live"), false);
});

test("public auth verifies the configured Basic credential", () => {
  const auth = createPublicAuth("versa", "correct horse battery staple", "0123456789abcdef");
  assert.equal(verifyPublicAuth(`Basic ${Buffer.from("versa:correct horse battery staple").toString("base64")}`, auth), true);
  assert.equal(verifyPublicAuth(`Basic ${Buffer.from("versa:wrong").toString("base64")}`, auth), false);
  assert.equal(verifyPublicAuth(`Basic ${Buffer.from("other:correct horse battery staple").toString("base64")}`, auth), false);
});



test("controlled execution uses authenticated identity even behind a loopback proxy", async () => {
  const { resolveOperatorIdentity } = await import("./public-auth.mjs");
  const auth = createPublicAuth("owner", "test-password", "test-salt");
  assert.throws(() => resolveOperatorIdentity({ auth, remoteAddress: "127.0.0.1", actor: "forged" }), /Authenticated/);
  assert.equal(resolveOperatorIdentity({ auth, remoteAddress: "127.0.0.1", actor: "forged", authorization: `Basic ${Buffer.from("owner:test-password").toString("base64")}` }), "owner");
  assert.throws(() => resolveOperatorIdentity({ remoteAddress: "203.0.113.1", actor: "forged" }), /Authenticated/);
  assert.equal(resolveOperatorIdentity({ remoteAddress: "127.0.0.1", actor: "tester" }), "local:tester");
});
