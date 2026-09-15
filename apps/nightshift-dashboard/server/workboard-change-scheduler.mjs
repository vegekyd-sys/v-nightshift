export class WorkboardChangeScheduler {
  constructor({
    debounceMs = 100,
    minRunIntervalMs = 5_000,
    now = Date.now,
    onError = () => {},
    repairIntervalMs = 300_000,
    run,
    setIntervalFn = setInterval,
    setTimeoutFn = setTimeout,
    clearIntervalFn = clearInterval,
    clearTimeoutFn = clearTimeout,
    workboard,
  }) {
    this.debounceMs = debounceMs;
    this.minRunIntervalMs = minRunIntervalMs;
    this.now = now;
    this.onError = onError;
    this.repairIntervalMs = repairIntervalMs;
    this.run = run;
    this.setIntervalFn = setIntervalFn;
    this.setTimeoutFn = setTimeoutFn;
    this.clearIntervalFn = clearIntervalFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.workboard = workboard;
    this.pending = new Set();
    this.running = false;
    this.stopped = true;
    this.debounceTimer = null;
    this.initialTimer = null;
    this.delayedTimer = null;
    this.delayedAt = null;
    this.repairTimer = null;
    this.unsubscribe = null;
    this.lastRunAt = null;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = this.workboard.onChange(() => this.enqueue("workboard.changed"));
    this.repairTimer = this.setIntervalFn(() => this.enqueue("repair"), this.repairIntervalMs);
    this.repairTimer.unref?.();
    this.initialTimer = this.setTimeoutFn(() => this.enqueue("startup"), 1_000);
    this.initialTimer.unref?.();
  }

  enqueue(trigger) {
    if (this.stopped) return;
    this.pending.add(trigger);
    if (this.running || this.debounceTimer) return;
    const intervalDelay = this.lastRunAt === null ? 0 : Math.max(0, this.lastRunAt + this.minRunIntervalMs - this.now());
    this.debounceTimer = this.setTimeoutFn(() => {
      this.debounceTimer = null;
      this.flush().catch(this.onError);
    }, Math.max(this.debounceMs, intervalDelay));
    this.debounceTimer.unref?.();
  }

  enqueueAfter(trigger, delayMs) {
    if (this.stopped) return;
    const dueAt = this.now() + Math.max(0, delayMs);
    if (this.delayedTimer && this.delayedAt <= dueAt) return;
    if (this.delayedTimer) this.clearTimeoutFn(this.delayedTimer);
    this.delayedAt = dueAt;
    this.delayedTimer = this.setTimeoutFn(() => {
      this.delayedTimer = null;
      this.delayedAt = null;
      this.enqueue(trigger);
    }, Math.max(0, delayMs));
    this.delayedTimer.unref?.();
  }

  async flush() {
    if (this.stopped || this.running || this.pending.size === 0) return;
    this.running = true;
    const triggers = [...this.pending];
    this.pending.clear();
    try {
      await this.run({ trigger: triggers.includes("repair") ? "repair" : triggers.join("+") });
    } finally {
      this.lastRunAt = this.now();
      this.running = false;
      if (this.pending.size > 0) this.enqueue("coalesced");
    }
  }

  stop() {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.debounceTimer) this.clearTimeoutFn(this.debounceTimer);
    if (this.initialTimer) this.clearTimeoutFn(this.initialTimer);
    if (this.delayedTimer) this.clearTimeoutFn(this.delayedTimer);
    if (this.repairTimer) this.clearIntervalFn(this.repairTimer);
    this.debounceTimer = null;
    this.initialTimer = null;
    this.delayedTimer = null;
    this.delayedAt = null;
    this.repairTimer = null;
    this.pending.clear();
  }
}
