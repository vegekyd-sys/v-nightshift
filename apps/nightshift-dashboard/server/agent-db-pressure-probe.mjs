import { execFile } from "node:child_process";

// Every Agent run writes its transcript through one process-global lease on the
// agent database. Night Shift cards write far more than chat turns, so when too
// many run at once the lease is what saturates: Workers still have room and the
// Gateway probe stays green, yet a writer that waits 5 s is killed mid-reply.
// On V this cut two people's replies at 10:21 and 10:22 on 2026-09-24 while
// every other dispatch signal read healthy. The Gateway logs both symptoms, so
// this probe reads them from its journal.
//
//   slow admission  a writer waited ≥ 1 s for the lease; precedes timeouts
//   timeout         a run died because the lease never came
//
// A timeout whose runId is not a Workboard run hit a person, not a card.

const RUN_END = "embedded run agent end";
const LEASE_TIMEOUT = "coordinator wait exceeded";
const SLOW_ADMISSION = "slow direct Agent DB process writer admission";
// Agents quote the timeout text in their own card notes. Only the Gateway's
// run-end line, which carries the runId, counts as a timeout.
const JOURNAL_GREP = `${RUN_END}.*${LEASE_TIMEOUT}|${SLOW_ADMISSION}`;

export function classifyAgentDbLines(lines) {
  const timeouts = new Map();
  let slowAdmissions = 0;
  for (const line of lines) {
    if (line.includes(SLOW_ADMISSION)) {
      slowAdmissions += 1;
      continue;
    }
    if (!line.includes(RUN_END) || !line.includes(LEASE_TIMEOUT)) continue;
    const runId = line.match(/runId=([^\s]+)/)?.[1];
    if (!runId) continue;
    // The worker and the Gateway each log the same failure; count the run once.
    timeouts.set(runId, { runId, interactive: !runId.startsWith("workboard:") });
  }
  const list = [...timeouts.values()];
  return {
    coordinatorTimeouts: list.length,
    interactiveTimeouts: list.filter((entry) => entry.interactive).length,
    interactiveRunIds: list.filter((entry) => entry.interactive).map((entry) => entry.runId),
    slowAdmissions,
  };
}

export function agentDbPressureLevel(counts, { slowAdmissionYellow }) {
  if (counts.coordinatorTimeouts > 0) return "red";
  if (counts.slowAdmissions >= slowAdmissionYellow) return "yellow";
  return "green";
}

export function createAgentDbPressureProbe({
  enabled = true,
  gatewayUrl,
  now = Date.now,
  platform = process.platform,
  readJournal = journalctl,
  slowAdmissionYellow = 3,
  unit = "openclaw-gateway",
  windowSeconds = 120,
  minIntervalMs = 15_000,
  unitCheckIntervalMs = 600_000,
} = {}) {
  let local = false;
  try { local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(gatewayUrl).hostname); } catch {}
  const active = Boolean(enabled) && platform === "linux" && local;
  const disabled = {
    enabled: false,
    level: "unknown",
    blocked: false,
    reason: enabled ? "Agent DB pressure is only readable on the Gateway host" : "Agent DB pressure probe disabled",
  };
  let cached = null;
  let unitCheckedAt = 0;
  let unitVisible = false;

  return async () => {
    if (!active) return disabled;
    const at = now();
    if (cached && at - Date.parse(cached.at) < minIntervalMs) return cached;
    try {
      // An empty grep result means either "no pressure" or "wrong unit". Confirm
      // the unit is readable before trusting silence as green.
      if (!unitVisible || at - unitCheckedAt >= unitCheckIntervalMs) {
        unitVisible = (await readJournal(["-q", "-u", unit, "-n", "1", "--no-pager", "-o", "cat"])).trim() !== "";
        unitCheckedAt = at;
      }
      if (!unitVisible) {
        cached = { enabled: true, at: new Date(at).toISOString(), level: "unknown", blocked: false,
          reason: `No journal entries readable for ${unit}; Agent DB pressure is not being observed` };
        return cached;
      }
      const output = await readJournal(["-q", "-u", unit, "--since", `-${windowSeconds}s`, "--no-pager", "-o", "cat", "--grep", JOURNAL_GREP]);
      const counts = classifyAgentDbLines(output.split("\n").filter(Boolean));
      const level = agentDbPressureLevel(counts, { slowAdmissionYellow });
      cached = {
        enabled: true,
        at: new Date(at).toISOString(),
        level,
        blocked: level === "red",
        userHarm: counts.interactiveTimeouts > 0,
        reason: level === "red"
          ? `${counts.coordinatorTimeouts} Agent DB lease timeout(s) in ${windowSeconds}s` +
            (counts.interactiveTimeouts ? `, ${counts.interactiveTimeouts} in a person's conversation` : "")
          : level === "yellow" ? `${counts.slowAdmissions} slow Agent DB writer admissions in ${windowSeconds}s` : null,
        windowSeconds,
        ...counts,
      };
      return cached;
    } catch (error) {
      // Observation only: a journal hiccup must not halt the night by itself.
      // The Gateway latency and host probes still gate dispatch.
      cached = { enabled: true, at: new Date(at).toISOString(), level: "unknown", blocked: false,
        reason: `Agent DB pressure probe failed: ${error.message}` };
      return cached;
    }
  };
}

function journalctl(args) {
  return new Promise((resolve, reject) => {
    execFile("journalctl", args, { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      // journalctl exits 1 when --grep matches nothing; that is an answer.
      if (error && !(error.code === 1 && stdout === "")) return reject(error);
      resolve(stdout);
    });
  });
}
