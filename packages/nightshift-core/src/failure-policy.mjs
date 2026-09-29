const RETRY_BACKOFF_MS = [60_000, 300_000, 900_000, 900_000, 1_800_000];

export function classifyTerminalFailure({ message, session } = {}) {
  const stopReason = String(message?.stopReason ?? "").toLowerCase();
  if (!stopReason || stopReason === "stop") return null;

  const rawError = boundedFailureText([
    errorText(message?.error),
    errorText(message?.errorMessage),
    errorText(message?.__openclaw?.error),
    errorText(message?.__openclaw?.errorMessage),
    errorText(session?.error),
    errorText(session?.errorMessage),
    messageText(message),
  ].filter(Boolean).join("\n")) || `Agent Session ended with ${stopReason}`;
  return classifyFailureText(rawError, stopReason);
}

// How the Gateway says a run ended (tasks.list, one entry per run). Only a run
// that failed, timed out or was cancelled yields a failure: a run that ended
// normally is judged by what the Agent left behind, never by this. On V
// (2026-09-26 to 09-29) every stop that needed a person — Makaron failing
// twice, a publication that failed, an output delivered by absolute path — had
// a run that ended normally; every failed or timed-out run was the substrate.
export function classifyRunOutcome(outcome) {
  const status = String(outcome?.status ?? "").toLowerCase();
  if (!["failed", "timed_out", "cancelled", "error"].includes(status)) return null;
  const rawError = boundedFailureText(errorText(outcome?.error)) || `Agent run ${status}`;
  // The Session finished; only the registry lagged. The transcript decides.
  if (/session completed before registry settled/i.test(rawError)) return null;
  if (status === "cancelled") return { kind: "run_cancelled", source: "gateway", rawError, retryable: false };
  const failure = classifyFailureText(rawError, status === "timed_out" ? "timeout" : "error");
  // A failed run is never the Agent's own verdict: an Agent that cannot go on
  // blocks its card and ends its turn normally.
  if (failure.kind === "agent_error") return { kind: "agent_interrupted", source: "gateway", rawError, retryable: true };
  return failure;
}

// The Gateway saw the run end on its own: the Agent took its turns and
// stopped. Its outputs and closing words decide, whatever the transcript shows.
export function runEndedNormally(outcome) {
  const status = String(outcome?.status ?? "").toLowerCase();
  if (["completed", "succeeded"].includes(status)) return true;
  return status === "failed" && /session completed before registry settled/i.test(errorText(outcome?.error));
}

function classifyFailureText(rawError, stopReason) {
  const normalized = rawError.toLowerCase();

  // The coordinator wait is the same SQLite contention as an outright lock: the
  // writer never got its turn. On V on 2026-09-17 two live produce cards were
  // blocked by it and, classified as an Agent failure, would never have retried.
  if (/database is locked|sqlite_busy|sqlite busy|db process coordinator wait exceeded/.test(normalized)) {
    return { kind: "database_lock", source: "gateway", rawError, retryable: true };
  }
  // The Worker never acknowledged or never progressed. That is the execution
  // substrate, not the Agent's own work, so it is worth another attempt.
  if (/worker stream acknowledgement timed out|worker request .*made no progress|worker (?:is )?unavailable/.test(normalized)) {
    return { kind: "worker_unavailable", source: "gateway", rawError, retryable: true };
  }
  if (/gateway(?: rpc)?(?: request)? (?:timed out|timeout|unavailable)|openclaw gateway rpc failed/.test(normalized)) {
    return { kind: "gateway_unavailable", source: "gateway", rawError, retryable: true };
  }
  // Real strings from V, 2026-09-10 to 09-17: every failure that landed in the
  // agent_error bucket was transient. "Connection error." is what the provider
  // client reports on its own, and an upstream 5xx arrives as an HTML body.
  if (/econnreset|connection reset|connection error|socket hang up|fetch failed|network error|timed? out/.test(normalized)) {
    return { kind: "connection_reset", source: "provider", rawError, retryable: true };
  }
  // The model produced a broken tool call or no usable response; another
  // attempt is a fresh request (V, 2026-09-29 21:05).
  if (/incomplete or malformed tool call|malformed tool call|request failed\.?$/.test(normalized)) {
    return { kind: "provider_error", source: "provider", rawError, retryable: true };
  }
  if (/\b(50[0234])\b|bad gateway|service unavailable|gateway time-?out|internal server error/.test(normalized)) {
    return { kind: "upstream_unavailable", source: "provider", rawError, retryable: true };
  }
  if (stopReason === "aborted" || /incomplete turn|interrupted/.test(normalized)) {
    return { kind: "agent_interrupted", source: "runtime", rawError, retryable: true };
  }
  return { kind: "agent_error", source: "runtime", rawError, retryable: false };
}

export function scheduleAutomaticRetry({ failure, failureCount, maxAttempts, nowMs = Date.now(), safeToRetry }) {
  if (!failure?.retryable || !safeToRetry) return { automaticRetry: false, nextRetryAt: null };
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || failureCount >= maxAttempts || failureCount > RETRY_BACKOFF_MS.length) {
    return { automaticRetry: false, nextRetryAt: null };
  }
  const delayMs = RETRY_BACKOFF_MS[Math.min(Math.max(0, failureCount - 1), RETRY_BACKOFF_MS.length - 1)];
  return { automaticRetry: true, nextRetryAt: new Date(nowMs + delayMs).toISOString() };
}

export function infrastructureFailureSummary(failure) {
  const label = {
    database_lock: "Gateway 数据库写入冲突",
    worker_unavailable: "执行 Worker 未响应",
    gateway_unavailable: "Gateway 暂时不可用",
    connection_reset: "模型或网络连接中断",
    upstream_unavailable: "上游服务返回 5xx",
    provider_error: "模型返回异常",
    agent_interrupted: "Agent 运行被中断",
    agent_not_started: "Agent 没能启动",
    run_cancelled: "Agent 运行被取消",
    agent_error: "Agent 运行失败",
  }[failure?.kind] ?? "Agent 运行失败";
  const recovery = failure?.automaticRetry && failure?.nextRetryAt
    ? `系统将在 ${failure.nextRetryAt} 自动恢复`
    : "需要人工检查后重试";
  return `${label}：${failure?.rawError ?? "unknown error"}。${recovery}`;
}

function errorText(value) {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object") {
    if (typeof value.message === "string") return value.message.trim();
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return "";
}

function messageText(message) {
  if (typeof message?.content === "string") return message.content.trim();
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text.trim())
    .filter(Boolean)
    .join("\n");
}

function boundedFailureText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
}
