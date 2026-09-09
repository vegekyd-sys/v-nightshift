const SKILL_PATH = /(?:^|\/)(?:skills|plugin-skills)\/([^/]+)\/SKILL\.md$/;

export function validateExecutionEvidence({ cardId, messages = [], requiredSkills = [] }) {
  const required = [...new Set(requiredSkills)].sort();
  const calls = collectToolCalls(messages);
  const loaded = [...new Set(calls.map(skillRead).filter(Boolean))].sort();
  const missing = required.filter((skill) => !loaded.includes(skill));
  const undeclared = loaded.filter((skill) => !required.includes(skill));
  if (undeclared.length > 0) {
    throw new Error(`Undeclared Skill was loaded in this attempt: ${undeclared.join(", ")}`);
  }

  const foreignCards = calls.flatMap((call) => mutationCardIds(call))
    .filter((id) => cardId && id !== cardId);
  if (foreignCards.length > 0) {
    throw new Error(`One-attempt-one-card violation: mutated ${[...new Set(foreignCards)].join(", ")}`);
  }
  return {
    declaredSkills: required,
    loadedSkills: loaded,
    missingSkillReadTelemetry: missing,
    skillEvidence: required.length === 0
      ? "not-required"
      : missing.length === 0
        ? "session-read"
        : "workboard-declaration",
    toolCallCount: calls.length,
  };
}

export function collectToolCalls(messages) {
  const calls = [];
  for (const message of messages ?? []) walk(message?.content, calls);
  return calls;
}

function walk(value, calls) {
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, calls);
    return;
  }
  if (!value || typeof value !== "object") return;
  const type = String(value.type ?? "").toLowerCase();
  if (type === "toolcall" || type === "tool_call" || value.toolName || value.name && (value.arguments || value.input)) {
    calls.push({
      name: String(value.name ?? value.toolName ?? ""),
      arguments: value.arguments ?? value.input ?? value.params ?? {},
    });
  }
  for (const [key, child] of Object.entries(value)) {
    if (!["arguments", "input", "params"].includes(key)) walk(child, calls);
  }
}

function skillRead(call) {
  if (call.name !== "read") return null;
  const path = String(call.arguments?.path ?? call.arguments?.file_path ?? "").replace(/\\/g, "/");
  return SKILL_PATH.exec(path)?.[1] ?? null;
}

function mutationCardIds(call) {
  if (["workboard_complete", "workboard_block", "workboard_heartbeat"].includes(call.name)) {
    return [call.arguments?.id ?? call.arguments?.cardId].filter(Boolean).map(String);
  }
  if (call.name !== "exec") return [];
  const command = String(call.arguments?.command ?? "");
  if (!/workboard\.cards\.(?:complete|block|heartbeat)/.test(command)) return [];
  const ids = [];
  for (const match of command.matchAll(/["'](?:id|cardId)["']\s*:\s*["']([^"']+)["']/g)) ids.push(match[1]);
  return ids;
}
