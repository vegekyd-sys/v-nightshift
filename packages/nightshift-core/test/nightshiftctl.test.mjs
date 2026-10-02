import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");

// nightshiftctl is an HTTP client of the Night Shift service. Operators and
// agents parse its output, so stderr must stay empty on success. It used to
// load the SQLite store through the package index and print Node's
// "SQLite is an experimental feature" warning on every run.
test("nightshiftctl prints only the API result, with no runtime warning on stderr", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/api/health" ? { ok: true, schedulerRunning: true } : { error: "not found" }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  try {
    const { NODE_OPTIONS, NODE_NO_WARNINGS, ...env } = process.env;
    const { stdout, stderr } = await execFileAsync(process.execPath, ["scripts/nightshiftctl.mjs", "health"], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, NIGHTSHIFT_URL: `http://127.0.0.1:${server.address().port}` },
    });
    assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { ok: true, schedulerRunning: true });
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});
