// The project card is a progress summary, not a dump of call records.
// Group by invocation identity so prior rounds stay history, not extra rows.
export function projectExecutions(project, stages = [], needsYou = []) {
  const titles = new Map(stages.map(stage => [stage.id, stage.title]));
  const items = new Map((project.contentItems ?? []).map(item => [item.id, item.title]));
  const groups = new Map();
  for (const call of project.calls ?? []) {
    const key = `${call.parentId ?? project.id}:${call.cardId ?? call.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(call);
  }
  return [...groups.entries()].map(([id, calls]) => {
    const rounds = [...calls].sort((a, b) => b.iteration - a.iteration);
    const latest = rounds[0];
    const decision = needsYou.find(item => item.kind === "decision" && latest.cardIds?.includes(item.cardId));
    return { id, title: titles.get(latest.stageId) ?? "子流程", itemTitle: items.get(latest.contentItemId) ?? null,
      latest, history: rounds.slice(1), taskId: decision?.cardId ?? latest.cardIds?.at(-1) ?? null };
  });
}

export function executionState(call) {
  if (call.state === "succeeded") return { label: "已完成", tone: "done" };
  if (call.blocked || call.state === "held") return { label: "待处理", tone: "attention" };
  if (call.state === "continued") return { label: "已进入下一轮", tone: "muted" };
  return { label: "进行中", tone: "running" };
}

export function executionReason(call) {
  const reason = call.reason ?? "";
  if (reason.startsWith("child-work-stopped")) return "子任务停下了，处理后可接着执行";
  if (reason.startsWith("external-outcome-unknown")) return "外部结果尚未查明，等待核实";
  if (reason.startsWith("output-contract")) return "等待补齐或修正执行结果";
  return ({ "iteration-limit": "已达到轮数上限", "duration-limit": "已达到执行时限", "no-matching-continuation: evidence or attention required": "等待确认下一步", "success-condition": "已满足完成条件", "repeat-condition": "按验证结果进入下一轮", "operator-recheck": "正在复查执行结果" })[reason] ?? (executionState(call).tone === "attention" ? "等待处理后继续" : executionState(call).tone === "done" ? "已完成" : "任务正在执行");
}
