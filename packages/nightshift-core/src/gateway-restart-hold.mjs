// Night Shift pauses while the Gateway restarts and picks its work back up
// when the Gateway returns. Nobody has to announce a restart: on V on
// 2026-09-30 two restarts (12:53, 13:01) by a release session ended two produce
// runs, one reached a person as if it needed a decision, and the sessions had
// to message each other to recover.
//
// Three signals, whichever comes first:
// - the Gateway's own `shutdown` broadcast, sent by every orderly stop or
//   restart, whoever asked for it (systemctl, a release script, SIGUSR1, a
//   config change that restarts);
// - the persistent connection dropping (a crash, SIGKILL, a stop that ran past
//   systemd's timeout never broadcasts);
// - a different Gateway boot id at the next hello, which also covers a restart
//   that happened while Night Shift itself was down.
//
// While held, the scheduler neither dispatches nor judges cards: a run the
// restart ended is not the Agent failing. Once the Gateway is back and has
// settled, the runs it interrupted are resumed (runtime.resumeAfterGatewayRestart)
// before normal scheduling starts again.

const STATE_KEY = "gateway-restart";
// A shutdown broadcast whose process never went away (an aborted stop) must
// not hold Night Shift forever.
const ABANDONED_SHUTDOWN_MS = 5 * 60_000;
const UP_WRITE_INTERVAL_MS = 60_000;

export class GatewayRestartHold {
  constructor({ store, settleMs = 60_000, abandonedShutdownMs = ABANDONED_SHUTDOWN_MS, now = () => Date.now() }) {
    if (!store) throw new Error("GatewayRestartHold requires a store");
    this.store = store;
    this.settleMs = settleMs;
    this.abandonedShutdownMs = abandonedShutdownMs;
    this.now = now;
    this.state = normalize(store.getServiceState(STATE_KEY));
  }

  snapshot() {
    return structuredClone(this.state);
  }

  save() {
    this.store.setServiceState(STATE_KEY, this.state, new Date(this.now()));
  }

  // event: { type: "shutdown", reason, restartExpectedMs } | { type: "disconnected" }
  //      | { type: "connected", bootId }
  // Returns the state after the event.
  observe(event) {
    const now = this.now();
    if (event?.type === "shutdown" || event?.type === "disconnected") {
      this.beginHold({
        reason: event.type === "shutdown" ? (event.reason || "gateway shutdown") : "gateway connection lost",
        restartExpectedMs: Number.isFinite(event.restartExpectedMs) ? event.restartExpectedMs : null,
        at: now,
      });
      return this.snapshot();
    }
    if (event?.type === "connected" && event.bootId) {
      this.connected(event.bootId, now);
      return this.snapshot();
    }
    return this.snapshot();
  }

  beginHold({ reason, restartExpectedMs = null, at }) {
    if (this.state.status === "holding") return;
    // A second restart while settling keeps the original window.
    const hold = this.state.status === "resuming" && this.state.hold
      ? this.state.hold
      : { since: iso(at), reason, restartExpectedMs, fromBootId: this.state.bootId ?? null };
    this.state = { ...this.state, status: "holding", hold, resume: null };
    this.save();
  }

  connected(bootId, now) {
    const { status } = this.state;
    if (status === "up") {
      if (this.state.bootId && this.state.bootId !== bootId) {
        // The Gateway restarted without Night Shift seeing it go.
        this.state = {
          ...this.state,
          status: "holding",
          hold: {
            since: this.state.lastUpAt ?? iso(now),
            reason: "gateway boot changed",
            restartExpectedMs: null,
            fromBootId: this.state.bootId,
          },
        };
        this.startResume(bootId, now);
        return;
      }
      this.state = { ...this.state, bootId, lastUpAt: iso(now) };
      this.save();
      return;
    }
    if (status === "holding") this.startResume(bootId, now);
    else if (status === "resuming" && this.state.resume?.bootId !== bootId) this.startResume(bootId, now);
  }

  startResume(bootId, now) {
    const fromBootId = this.state.hold?.fromBootId ?? null;
    this.state = {
      ...this.state,
      status: "resuming",
      resume: {
        bootId,
        returnedAt: iso(now),
        resumeAt: iso(now + this.settleMs),
        // Unknown means unproven: only runs the Gateway reports as ended count.
        bootChanged: Boolean(fromBootId && fromBootId !== bootId),
      },
    };
    this.save();
  }

  // Called before every scheduler pass.
  //   { hold: true, retryAfterMs }  skip the pass
  //   { pickup: window }            resume interrupted runs, then complete()
  //   { hold: false }               schedule as usual
  gate({ connected = false, bootId = null } = {}) {
    const now = this.now();
    if (this.state.status === "holding") {
      if (connected && bootId) {
        if (bootId !== this.state.hold?.fromBootId) this.startResume(bootId, now);
        else if (now - Date.parse(this.state.hold.since) >= this.abandonedShutdownMs) this.startResume(bootId, now);
        else return { hold: true, retryAfterMs: this.settleMs };
      } else {
        return { hold: true, retryAfterMs: this.settleMs };
      }
    }
    if (this.state.status === "resuming") {
      const resumeAt = Date.parse(this.state.resume.resumeAt);
      if (now < resumeAt) return { hold: true, retryAfterMs: resumeAt - now };
      return {
        pickup: {
          from: this.state.hold?.since ?? this.state.resume.returnedAt,
          to: this.state.resume.returnedAt,
          reason: this.state.hold?.reason ?? "gateway restart",
          fromBootId: this.state.hold?.fromBootId ?? null,
          bootId: this.state.resume.bootId,
          bootChanged: this.state.resume.bootChanged,
        },
      };
    }
    if (bootId && connected && (!this.state.lastUpAt || now - Date.parse(this.state.lastUpAt) >= UP_WRITE_INTERVAL_MS)) {
      this.state = { ...this.state, bootId: this.state.bootId ?? bootId, lastUpAt: iso(now) };
      this.save();
    }
    return { hold: false };
  }

  complete(window, outcome = {}) {
    const now = this.now();
    this.state = {
      status: "up",
      bootId: window.bootId,
      lastUpAt: iso(now),
      hold: null,
      resume: null,
      last: {
        from: window.from,
        to: window.to,
        reason: window.reason,
        fromBootId: window.fromBootId,
        bootId: window.bootId,
        resumedAt: iso(now),
        resumed: outcome.resumed ?? [],
        handedOver: outcome.handedOver ?? [],
      },
    };
    this.save();
    return this.snapshot();
  }
}

function normalize(saved) {
  if (!saved || !["up", "holding", "resuming"].includes(saved.status)) {
    return { status: "up", bootId: saved?.bootId ?? null, lastUpAt: saved?.lastUpAt ?? null, hold: null, resume: null, last: saved?.last ?? null };
  }
  return saved;
}

function iso(ms) {
  return new Date(ms).toISOString();
}
