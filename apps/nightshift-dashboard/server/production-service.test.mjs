import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production sandbox allows the OpenClaw CLI health-state write", async () => {
  const unit = await readFile(
    new URL("../../../systemd/nightshift-workboard.service", import.meta.url),
    "utf8",
  );

  assert.match(unit, /^ProtectHome=read-only$/m);
  assert.match(
    unit,
    /^ReadWritePaths=.*\/home\/openclaw\/\.openclaw\/nightshift.*\/home\/openclaw\/\.openclaw\/state$/m,
  );
  assert.match(unit, /^Environment=NIGHTSHIFT_PUBLIC_BASE_URL=https:\/\/nightshift\.tianyi\.live$/m);
});

test("production deploy waits for the Workboard health endpoint", async () => {
  const script = await readFile(
    new URL("../../../scripts/manage-nightshift-production.sh", import.meta.url),
    "utf8",
  );

  assert.match(script, /^wait_for_health\(\) \{$/m);
  assert.equal((script.match(/^\s+wait_for_health$/gm) ?? []).length, 2);
  assert.match(script, /Release artifact is missing apps\/nightshift-dashboard\/dist\/index\.html/);
  assert.doesNotMatch(script, /grep -E?q/);
});

test("release packager builds and includes the dashboard distribution", async () => {
  const script = await readFile(
    new URL("../../../scripts/package-nightshift-release.sh", import.meta.url),
    "utf8",
  );

  assert.match(script, /npm --prefix "\$stage" run dashboard:build/);
  assert.match(script, /printf '%s\\n' "\$commit_sha" >"\$stage\/RELEASE_COMMIT"/);
});

test("project start cannot bypass the Gateway pressure guard", async () => {
  const server = await readFile(new URL("./index.mjs", import.meta.url), "utf8");

  assert.match(server, /const result = await scheduleStartedInstance\(instanceId\);/);
  assert.match(server, /serializedTick\(instanceId, \{ dispatch: false, dryRun: false \}\)/);
  assert.match(server, /changeScheduler\.enqueue\("instance\.started"\)/);
  assert.doesNotMatch(server, /serializedTick\(instanceId, \{ dispatch: true, dryRun: false \}\)/);
});

// The scheduler pass catches its own failures and never rejects, so a retry
// wired only to the event scheduler's onError never ran. Both paths must arm it.
test("a failed scheduler pass arms its own retry", async () => {
  const server = await readFile(new URL("./index.mjs", import.meta.url), "utf8");
  const passFailure = server.slice(server.indexOf("Night Shift scheduler failed"));
  assert.match(passFailure.slice(0, 260), /scheduleSchedulerRetry\(\)/,
    "the pass-level catch must arm the retry, not rely on onError");
  assert.match(server, /function scheduleSchedulerRetry\(\)[\s\S]{0,300}enqueueAfter\("scheduler\.retry"/);
  assert.match(server, /onError: \(error\) => \{[\s\S]{0,200}scheduleSchedulerRetry\(\)/);
});

// V, 2026-11-09: a host drop-in kept Night Shift on /opt/openclaw-2026.9.1-v, a
// stock 9.1 install, while the Gateway had run the patched core since 09-15.
test("Night Shift loads the Gateway's own OpenClaw and retires the host drop-in that overrode it", async () => {
  const unit = await readFile(new URL("../../../systemd/nightshift-workboard.service", import.meta.url), "utf8");
  assert.match(unit, /^Environment=NIGHTSHIFT_OPENCLAW_ENTRY=\/opt\/openclaw-experiments\/db91-release-v2026\.9\.1-db91\.6\/core\/dist\/index\.js$/m);
  assert.doesNotMatch(unit, /^Environment=.*(openclaw-2026\.7\.1|openclaw-2026\.9\.1-v)/m);
  const script = await readFile(new URL("../../../scripts/manage-nightshift-production.sh", import.meta.url), "utf8");
  assert.match(script, /^legacy_entry_dropin=\/etc\/systemd\/system\/nightshift-workboard\.service\.d\/91-openclaw91\.conf$/m);
  const deploy = script.slice(script.indexOf('install -o root -g root -m 644 "$release/systemd/nightshift-workboard.service"'));
  assert.match(deploy.slice(0, 600), /cp -a "\$legacy_entry_dropin" "\$backup\/legacy-entry-dropin\.before"[\s\S]*rm -f "\$legacy_entry_dropin"/);
  assert.ok(deploy.indexOf('rm -f "$legacy_entry_dropin"') < deploy.indexOf("systemctl daemon-reload"), "the drop-in is gone before the reload");
  const rollback = script.slice(script.indexOf("  rollback)"));
  assert.match(rollback, /cp -a "\$backup\/legacy-entry-dropin\.before" "\$legacy_entry_dropin"/);
});
