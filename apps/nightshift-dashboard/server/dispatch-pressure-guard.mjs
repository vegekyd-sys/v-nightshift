export class DispatchPressureGuard {
  constructor({
    greenLatencyMs = 250,
    initialMaxActive = 3,
    maxActive = 36,
    minActive = 1,
    now = Date.now,
    redLatencyMs = 1_000,
    redCooldownMs = 60_000,
    samplesToGrow = 2,
  } = {}) {
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
    this.lastProbe = null;
  }

  recordProbe({ error = null, latencyMs = null, running = 0 } = {}) {
    const at = this.now();
    const normalizedLatency = Number.isFinite(latencyMs) ? Math.max(0, latencyMs) : null;
    if (error || normalizedLatency === null || normalizedLatency >= this.redLatencyMs) {
      this.targetMaxActive = Math.max(this.minActive, Math.floor(this.targetMaxActive / 2));
      this.greenStreak = 0;
      this.holdUntilMs = at + this.redCooldownMs;
      this.lastProbe = {
        at: new Date(at).toISOString(),
        error: error ? String(error) : null,
        latencyMs: normalizedLatency,
        level: "red",
      };
      return this.snapshot(running);
    }
    if (normalizedLatency > this.greenLatencyMs) {
      this.targetMaxActive = Math.max(this.minActive, Math.min(this.targetMaxActive, Math.max(this.minActive, running)));
      this.greenStreak = 0;
      this.holdUntilMs = at + this.redCooldownMs;
      this.lastProbe = {
        at: new Date(at).toISOString(), error: null, latencyMs: normalizedLatency, level: "yellow",
      };
      return this.snapshot(running);
    }
    this.greenStreak += 1;
    if (at >= this.holdUntilMs && this.greenStreak >= this.samplesToGrow) {
      this.holdUntilMs = 0;
      this.targetMaxActive = Math.min(this.maxActive, this.targetMaxActive + 1);
      this.greenStreak = 0;
    }
    this.lastProbe = {
      at: new Date(at).toISOString(), error: null, latencyMs: normalizedLatency, level: "green",
    };
    return this.snapshot(running);
  }

  snapshot(running = 0) {
    const hold = this.now() < this.holdUntilMs;
    return {
      availableStarts: hold ? 0 : Math.max(0, this.targetMaxActive - Math.max(0, running)),
      dispatchAllowed: !hold,
      greenLatencyMs: this.greenLatencyMs,
      holdUntil: hold ? new Date(this.holdUntilMs).toISOString() : null,
      lastProbe: this.lastProbe,
      maxActive: this.maxActive,
      redLatencyMs: this.redLatencyMs,
      running: Math.max(0, running),
      targetMaxActive: this.targetMaxActive,
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
