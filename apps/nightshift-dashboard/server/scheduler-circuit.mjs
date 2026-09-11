const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

export function isGatewayPressureFailure(message) {
  return /gateway(?: rpc)? (?:failed|timeout)|database is locked|sqlite_(?:busy|locked)/i.test(String(message ?? ""));
}

export class SchedulerCircuit {
  constructor({ cooldownMs = DEFAULT_COOLDOWN_MS, now = () => Date.now() } = {}) {
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.openUntilMs = 0;
    this.reason = null;
    this.probeRequired = false;
  }

  beforePass() {
    const now = this.now();
    if (!this.probeRequired) return { dispatch: true, run: true };
    if (now < this.openUntilMs) {
      return { dispatch: false, retryAfterMs: this.openUntilMs - now, run: false };
    }
    return { dispatch: false, probe: true, run: true };
  }

  recordFailure(message) {
    if (!isGatewayPressureFailure(message)) return false;
    this.probeRequired = true;
    this.openUntilMs = this.now() + this.cooldownMs;
    this.reason = String(message);
    return true;
  }

  recordPass(warnings = [], { probe = false } = {}) {
    const pressureWarning = warnings.find(isGatewayPressureFailure);
    if (pressureWarning) {
      this.recordFailure(pressureWarning);
      return;
    }
    if (probe) {
      this.probeRequired = false;
      this.openUntilMs = 0;
      this.reason = null;
    }
  }

  snapshot() {
    return {
      open: this.probeRequired,
      openUntil: this.openUntilMs ? new Date(this.openUntilMs).toISOString() : null,
      probeRequired: this.probeRequired,
      reason: this.reason,
    };
  }
}
