// Why cards that could start are not starting, measured in time.
//
// Every brake decides on its own and none of them recorded that it held, so
// nobody could say which one kept the board below capacity. On V
// (2026-10-14..21) cards waited to start in 37% of all minutes; in 45 of those
// hours fewer than 11 ran. Only by joining Workboard events with the Gateway's
// RSS could the cause be inferred: with the Gateway under 5 GiB about 12 cards
// ran (the Worker pool), above 6.5 GiB about 7 (the host memory reserve).
// After a machine or configuration change this ledger answers it directly.
//
// The service observes every few seconds. Each interval goes to the brake that
// held when it began, or to "starting" when starts were allowed, and only while
// a card was waiting to start; time with nothing to start is not counted.

// The first brake that holds, in the order they gate a start. `pressure` is
// DispatchPressureGuard.snapshot(); `warmup` is warmupAdmission().
export function dispatchHoldReason({ waiting, gatewayStatus = "up", circuitOpen = false, pressure, warmup }) {
  if (!waiting) return null;
  if (gatewayStatus !== "up") return "gateway-restart";
  if (circuitOpen) return "scheduler-circuit";
  const probe = pressure?.lastProbe;
  if (!probe) return "no-probe";
  const host = pressure.hostPressure;
  if (host?.blocked) {
    const reason = String(host.reason ?? "");
    if (reason.includes("memory headroom")) return "host-memory-headroom";
    if (reason.includes("reclaim")) return "host-memory-stall";
    if (reason.includes("swap")) return "host-swap";
    if (reason.includes("warming")) return "host-sample-warmup";
    return "host-probe-failed";
  }
  if (probe.level === "red") {
    if (pressure.agentDbPressure?.level === "red") return pressure.agentDbPressure.userHarm ? "agent-db-harm" : "agent-db-lease-timeout";
    return probe.error ? "gateway-probe-error" : "gateway-latency-red";
  }
  if (probe.level === "yellow") {
    return pressure.agentDbPressure?.level === "yellow" ? "agent-db-slow-admission" : "gateway-latency-yellow";
  }
  if (pressure.holdUntil) return "red-cooldown";
  if (pressure.recoveringPressure) return "recovering";
  if ((pressure.workerPool?.queued ?? 0) > 0) return "worker-queue";
  if (pressure.workerHeadroom === 0) return "worker-capacity";
  if (pressure.running >= pressure.targetMaxActive) {
    return pressure.harmCeiling !== null && pressure.harmCeiling <= pressure.targetMaxActive ? "harm-ceiling" : "target-max-active";
  }
  if (warmup && warmup.available === 0) return "warmup";
  if (!pressure.dispatchAllowed) return "awaiting-probe";
  return "starting";
}

export class DispatchHoldLedger {
  constructor({
    now = Date.now,
    // An observation gap longer than this (a stalled event loop, a suspended
    // host) is counted only up to it, so one stall cannot dominate a window.
    maxGapMs = 60_000,
    summaryIntervalMs = 900_000,
    log = (line) => console.log(line),
  } = {}) {
    this.now = now;
    this.maxGapMs = maxGapMs;
    this.summaryIntervalMs = summaryIntervalMs;
    this.log = log;
    this.startedAt = now();
    this.total = emptyWindow();
    this.window = emptyWindow();
    this.windowStartedAt = this.startedAt;
    this.last = null;
  }

  // reason: dispatchHoldReason(); context: what the summary line reports beside it.
  observe(reason, context = {}) {
    const at = this.now();
    if (this.last) {
      const elapsed = Math.min(Math.max(0, at - this.last.at), this.maxGapMs);
      for (const bucket of [this.total, this.window]) add(bucket, this.last.reason, elapsed);
    }
    this.last = { at, reason, since: this.last?.reason === reason ? this.last.since : at };
    if (at - this.windowStartedAt >= this.summaryIntervalMs) {
      if (this.window.waitingMs > 0) {
        this.log(JSON.stringify({
          event: "dispatch.holds",
          from: new Date(this.windowStartedAt).toISOString(),
          to: new Date(at).toISOString(),
          waitingMs: this.window.waitingMs,
          byReason: this.window.byReason,
          ...context,
        }));
      }
      this.window = emptyWindow();
      this.windowStartedAt = at;
    }
  }

  snapshot() {
    return {
      since: new Date(this.startedAt).toISOString(),
      waitingMs: this.total.waitingMs,
      byReason: { ...this.total.byReason },
      current: this.last ? { reason: this.last.reason, since: new Date(this.last.since).toISOString() } : null,
    };
  }
}

function emptyWindow() {
  return { waitingMs: 0, byReason: {} };
}

function add(bucket, reason, elapsed) {
  if (!reason || elapsed <= 0) return;
  bucket.waitingMs += elapsed;
  bucket.byReason[reason] = (bucket.byReason[reason] ?? 0) + elapsed;
}
