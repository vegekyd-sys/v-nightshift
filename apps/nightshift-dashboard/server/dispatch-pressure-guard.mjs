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
    reservedInteractiveWorkers = 3,
    // After a card's writes cut a person's reply, back off long enough for the
    // conversation to finish rather than returning at the next quiet probe.
    userHarmCooldownMs = 900_000,
    // The concurrency that cut a person's reply is remembered: recovery stays
    // below it and climbs back one card per step instead of per probe.
    harmCeilingRatio = 0.7,
    harmCeilingStepMs = 300_000,
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
    this.recoveryGreenStartedAt = null;
    this.recoveryGreenSamples = 0;
    this.holdUntilMs = 0;
    this.recoveringPressure = false;
    this.idleLatencySamples = [];
    this.lastProbe = null;
    this.startCredits = 0;
    this.probeMaxAgeMs = positiveInteger(probeMaxAgeMs, "probeMaxAgeMs");
    this.reservedInteractiveSlots = positiveInteger(reservedInteractiveSlots, "reservedInteractiveSlots");
    this.reservedInteractiveWorkers = positiveInteger(reservedInteractiveWorkers, "reservedInteractiveWorkers");
    this.userHarmCooldownMs = positiveInteger(userHarmCooldownMs, "userHarmCooldownMs");
    this.userHarmHoldUntilMs = 0;
    this.harmCeilingRatio = positiveNumber(harmCeilingRatio, "harmCeilingRatio");
    if (this.harmCeilingRatio >= 1) throw new Error("harmCeilingRatio must be below 1");
    this.harmCeilingStepMs = positiveInteger(harmCeilingStepMs, "harmCeilingStepMs");
    this.harmCeilingBase = null;
    this.harmCeilingAt = 0;
    this.harmRunIds = [];
    this.workerPool = null;
    this.hostPressure = null;
    this.agentDbPressure = null;
  }

  recordProbe({
    error = null, latencyMs = null, running = 0, workerPool = null, hostPressure = null, agentDbPressure = null,
  } = {}) {
    const at = this.now();
    this.workerPool = workerPool;
    this.hostPressure = hostPressure;
    this.agentDbPressure = agentDbPressure;
    if (hostPressure?.blocked) error = hostPressure.reason || "host under resource pressure";
    // Lease timeouts are red: cards are already killing runs. Slow admissions are
    // yellow: the lease is contended and one more writer is what tips it over.
    if (!error && agentDbPressure?.level === "red") error = agentDbPressure.reason || "Agent DB lease timeouts";
    const lockContended = agentDbPressure?.level === "yellow";
    const redCooldownMs = agentDbPressure?.userHarm
      ? Math.max(this.redCooldownMs, this.userHarmCooldownMs)
      : this.redCooldownMs;
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
      this.recoveryGreenStartedAt = null;
      this.recoveryGreenSamples = 0;
      const harmedBefore = at < this.userHarmHoldUntilMs;
      // A repeated red extends the hold from now; it never shortens a longer one.
      this.holdUntilMs = Math.max(this.holdUntilMs, at + redCooldownMs);
      if (agentDbPressure?.userHarm) {
        this.userHarmHoldUntilMs = this.holdUntilMs;
        this.recordHarm(at, normalizedRunning, agentDbPressure.interactiveRunIds, harmedBefore);
      }
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
    if (lockContended || normalizedLatency > thresholds.greenLatencyMs) {
      this.targetMaxActive = Math.max(this.minActive, Math.min(this.targetMaxActive, Math.max(this.minActive, normalizedRunning)));
      this.greenStreak = 0;
      this.recoveryGreenStartedAt = null;
      this.recoveryGreenSamples = 0;
      // Yellow means pause until observed recovery, not another red cooldown.
      // Periodic healthy-host maintenance must not indefinitely extend a hold.
      // An existing red deadline remains intact.
      this.recoveringPressure = true;
      this.startCredits = 0;
      this.lastProbe = {
        at: new Date(at).toISOString(),
        error: lockContended ? agentDbPressure.reason ?? "Agent DB lease contended" : null,
        latencyMs: normalizedLatency,
        level: "yellow",
      };
      return this.snapshot(normalizedRunning);
    }
    // A periodic isolated pause must not starve a healthy pool forever. Four
    // fresh successful probes spanning at least 15 seconds can end the red
    // cooldown early. Recovery admits only one new job, then needs new probes.
    const recoveryHeadroom = workerPool && workerPool.queued === 0 &&
      workerPool.capacity - workerPool.active > this.reservedInteractiveSlots;
    const continuous = this.lastProbe?.level === "green" &&
      at - Date.parse(this.lastProbe.at) <= this.probeMaxAgeMs;
    if (this.recoveringPressure && recoveryHeadroom) {
      if (!continuous || this.recoveryGreenStartedAt === null) {
        this.recoveryGreenStartedAt = at;
        this.recoveryGreenSamples = 0;
      }
      this.recoveryGreenSamples += 1;
      // Quiet probes may end an ordinary red early, but not the hold that
      // follows a person's reply being cut: a quiet lease a few seconds later
      // says nothing about the conversation still in progress.
      if (this.recoveryGreenSamples >= 4 && at - this.recoveryGreenStartedAt >= 15_000 && at >= this.userHarmHoldUntilMs) {
        this.holdUntilMs = 0;
        this.greenStreak = this.samplesToGrow - 1;
      }
    } else {
      this.recoveryGreenStartedAt = null;
      this.recoveryGreenSamples = 0;
    }
    if (at < this.holdUntilMs) {
      this.greenStreak = 0;
      this.startCredits = 0;
    } else {
      this.greenStreak += 1;
    }
    if (this.greenStreak >= this.samplesToGrow) {
      this.holdUntilMs = 0;
      // Existing jobs keep running during a pause. Once recovery is observed,
      // allow one new job beyond current occupancy instead of rebuilding an
      // artificial ceiling below the jobs that are already running.
      this.targetMaxActive = Math.min(this.maxActive, this.harmCeiling(at) ?? this.maxActive, Math.max(
        this.targetMaxActive + 1,
        this.recoveringPressure ? normalizedRunning + 1 : this.minActive,
      ));
      this.recoveringPressure = false;
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
    const sessionCapacity = this.workerPool
      ? Math.max(0, this.workerPool.capacity - Math.max(this.reservedInteractiveSlots, foreground) - running)
      : Infinity;
    // The pool gives each Session a whole Worker before it packs a second one
    // into any process, so N running cards hold N Workers, not N divided by
    // sessionsPerWorker. Counting interactive headroom in Session slots
    // therefore protects a resource that is not the bottleneck: on V, 7 cards
    // held 7 of 11 live Workers and left one free, while the Session
    // arithmetic still reported 45 - 9 - 7 = 29 spare and kept dispatching.
    const workerHeadroom = Number.isSafeInteger(this.workerPool?.workerCapacity)
        && Number.isSafeInteger(this.workerPool?.workersBusy)
      ? Math.max(0, this.workerPool.workerCapacity - this.reservedInteractiveWorkers - this.workerPool.workersBusy)
      : Infinity;
    const capacity = Math.min(sessionCapacity, workerHeadroom);
    const poolBusy = (this.workerPool?.queued ?? 0) > 0;
    const availableStarts = !probed || hold || this.recoveringPressure || poolBusy ? 0
      : Math.min(this.startCredits, Math.max(0, this.targetMaxActive - Math.max(0, running)), capacity);
    return {
      workerPool: this.workerPool,
      hostPressure: this.hostPressure,
      agentDbPressure: this.agentDbPressure,
      reservedInteractiveSlots: this.reservedInteractiveSlots,
      reservedInteractiveWorkers: this.reservedInteractiveWorkers,
      workerHeadroom: Number.isFinite(workerHeadroom) ? workerHeadroom : null,
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
      harmCeiling: this.harmCeiling(this.now()),
    };
  }

  // One harm is one set of cut replies. The probe reports the same runs for its
  // whole window, and the cards drain meanwhile; counting each report again
  // would ratchet the ceiling down to one. On V (2026-09-28 15:10) recovery
  // went straight back to the ten cards that had cut a reply at 14:55, and cut
  // two more at 15:22.
  recordHarm(at, running, runIds, harmedBefore) {
    const ids = Array.isArray(runIds) ? runIds.filter((id) => typeof id === "string") : [];
    const fresh = ids.length > 0 ? ids.some((id) => !this.harmRunIds.includes(id)) : !harmedBefore;
    this.harmRunIds = [...this.harmRunIds, ...ids.filter((id) => !this.harmRunIds.includes(id))].slice(-200);
    if (!fresh) return;
    const ceiling = Math.max(this.minActive, Math.floor(running * this.harmCeilingRatio));
    const current = this.harmCeiling(at);
    this.harmCeilingBase = current === null ? ceiling : Math.min(current, ceiling);
    // The ceiling starts to relax when the harm hold ends, not while it runs;
    // otherwise a 15-minute hold would already have climbed three steps back.
    this.harmCeilingAt = this.userHarmHoldUntilMs;
    this.targetMaxActive = Math.min(this.targetMaxActive, this.harmCeilingBase);
  }

  harmCeiling(at) {
    if (this.harmCeilingBase === null) return null;
    const ceiling = this.harmCeilingBase + Math.floor(Math.max(0, at - this.harmCeilingAt) / this.harmCeilingStepMs);
    if (ceiling < this.maxActive) return ceiling;
    this.harmCeilingBase = null;
    return null;
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
