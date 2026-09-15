export class DispatchPressureGuard {
  constructor({
    baselineGreenMultiplier = 1.25,
    baselineRedMultiplier = 2,
    greenLatencyMs = 250,
    initialMaxActive = 3,
    maxActive = 36,
    minActive = 1,
    now = Date.now,
    redLatencyMs = 1_000,
    redCooldownMs = 60_000,
    samplesToGrow = 2,
    probeMaxAgeMs = 10_000,
    reservedInteractiveSlots = 9,
  } = {}) {
    this.baselineGreenMultiplier = positiveNumber(baselineGreenMultiplier, "baselineGreenMultiplier");
    this.baselineRedMultiplier = positiveNumber(baselineRedMultiplier, "baselineRedMultiplier");
    if (this.baselineRedMultiplier <= this.baselineGreenMultiplier) {
      throw new Error("baselineRedMultiplier must exceed baselineGreenMultiplier");
    }
    this.greenLatencyMs = positiveNumber(greenLatencyMs, "greenLatencyMs");
    this.redLatencyMs = positiveNumber(redLatencyMs, "redLatencyMs");
    if (this.redLatencyMs <= this.greenLatencyMs) throw new Error("redLatencyMs must exceed greenLatencyMs");
    this.minActive = positiveInteger(minActive, "minActive");
    this.maxActive = positiveInteger(maxActive, "maxActive");
    if (this.minActive > this.maxActive) throw new Error("minActive cannot exceed maxActive");
    this.targetMaxActive = clamp(positiveInteger(initialMaxActive, "initialMaxActive"), this.minActive, this.maxActive);
    this.samplesToGrow = positiveInteger(samplesToGrow, "samplesToGrow");
    this.redCooldownMs = positiveInteger(redCooldownMs, "redCooldownMs");
    this.now = now;
    this.greenStreak = 0;
    this.holdUntilMs = 0;
    this.recoveringPressure = false;
    this.idleLatencySamples = [];
    this.lastProbe = null;
    this.startCredits = 0;
    this.probeMaxAgeMs = positiveInteger(probeMaxAgeMs, "probeMaxAgeMs");
    this.reservedInteractiveSlots = positiveInteger(reservedInteractiveSlots, "reservedInteractiveSlots");
    this.workerPool = null;
  }

  recordProbe({ error = null, latencyMs = null, running = 0, workerPool = null } = {}) {
    const at = this.now();
    this.workerPool = workerPool;
    const normalizedRunning = Math.max(0, Number(running) || 0);
    const normalizedLatency = Number.isFinite(latencyMs) ? Math.max(0, latencyMs) : null;
    if (!error && normalizedLatency !== null && normalizedRunning === 0 && (!workerPool || workerPool.active === 0) && normalizedLatency < this.redLatencyMs) {
      this.idleLatencySamples.push(normalizedLatency);
      if (this.idleLatencySamples.length > 8) this.idleLatencySamples.shift();
    }
    const thresholds = this.effectiveThresholds();
    if (error || normalizedLatency === null || normalizedLatency >= thresholds.redLatencyMs) {
      this.targetMaxActive = Math.max(this.minActive, Math.floor(this.targetMaxActive / 2));
      this.greenStreak = 0;
      this.holdUntilMs = at + this.redCooldownMs;
      this.recoveringPressure = true;
      this.startCredits = 0;
      this.lastProbe = {
        at: new Date(at).toISOString(),
        error: error ? String(error) : null,
        latencyMs: normalizedLatency,
        level: "red",
      };
      return this.snapshot(normalizedRunning);
    }
    if (normalizedLatency > thresholds.greenLatencyMs) {
      this.targetMaxActive = Math.max(this.minActive, Math.min(this.targetMaxActive, Math.max(this.minActive, normalizedRunning)));
      this.greenStreak = 0;
      // Yellow means pause until observed recovery, not another red cooldown.
      // Periodic healthy-host maintenance must not indefinitely extend a hold.
      // An existing red deadline remains intact.
      this.recoveringPressure = true;
      this.startCredits = 0;
      this.lastProbe = {
        at: new Date(at).toISOString(), error: null, latencyMs: normalizedLatency, level: "yellow",
      };
      return this.snapshot(normalizedRunning);
    }
    if (at < this.holdUntilMs) {
      this.greenStreak = 0;
      this.startCredits = 0;
    } else {
      this.greenStreak += 1;
    }
    if (this.greenStreak >= this.samplesToGrow) {
      this.holdUntilMs = 0;
      this.recoveringPressure = false;
      this.targetMaxActive = Math.min(this.maxActive, this.targetMaxActive + 1);
      this.greenStreak = 0;
    }
    if (!this.recoveringPressure && at >= this.holdUntilMs && normalizedRunning < this.targetMaxActive) {
      // One successful probe authorizes one cold start. A second start needs a
      // fresh probe so a burst cannot outrun the ordinary-Session SLO signal.
      this.startCredits = Math.max(this.startCredits, 1);
    }
    this.lastProbe = {
      at: new Date(at).toISOString(), error: null, latencyMs: normalizedLatency, level: "green",
    };
    return this.snapshot(normalizedRunning);
  }

  snapshot(running = 0) {
    const probed = this.lastProbe !== null && this.now() - Date.parse(this.lastProbe.at) <= this.probeMaxAgeMs;
    const hold = this.now() < this.holdUntilMs;
    const thresholds = this.effectiveThresholds();
    const foreground = Math.max(0, (this.workerPool?.active ?? running) - running);
    const capacity = this.workerPool
      ? Math.max(0, this.workerPool.capacity - Math.max(this.reservedInteractiveSlots, foreground) - running)
      : Infinity;
    const poolBusy = (this.workerPool?.queued ?? 0) > 0;
    const availableStarts = !probed || hold || this.recoveringPressure || poolBusy ? 0
      : Math.min(this.startCredits, Math.max(0, this.targetMaxActive - Math.max(0, running)), capacity);
    return {
      workerPool: this.workerPool,
      reservedInteractiveSlots: this.reservedInteractiveSlots,
      recoveringPressure: this.recoveringPressure,
      availableStarts: availableStarts,
      baselineLatencyMs: thresholds.baselineLatencyMs,
      dispatchAllowed: availableStarts > 0,
      greenLatencyMs: thresholds.greenLatencyMs,
      holdUntil: hold ? new Date(this.holdUntilMs).toISOString() : null,
      lastProbe: this.lastProbe,
      maxActive: this.maxActive,
      redLatencyMs: thresholds.redLatencyMs,
      running: Math.max(0, running),
      targetMaxActive: this.targetMaxActive,
    };
  }

  consumeStarts(count) {
    const consumed = Math.max(0, Number(count) || 0);
    this.startCredits = Math.max(0, this.startCredits - consumed);
  }

  effectiveThresholds() {
    const baselineLatencyMs = upperQuartile(this.idleLatencySamples);
    return {
      baselineLatencyMs,
      greenLatencyMs: baselineLatencyMs === null
        ? this.greenLatencyMs
        : Math.max(this.greenLatencyMs, Math.ceil(baselineLatencyMs * this.baselineGreenMultiplier)),
      redLatencyMs: baselineLatencyMs === null
        ? this.redLatencyMs
        : Math.max(this.redLatencyMs, Math.ceil(baselineLatencyMs * this.baselineRedMultiplier)),
    };
  }
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be positive`);
  return parsed;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function upperQuartile(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.75) - 1];
}
