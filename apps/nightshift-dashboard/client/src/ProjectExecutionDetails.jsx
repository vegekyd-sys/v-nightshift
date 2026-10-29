import React, { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { executionReason, executionState, projectExecutions } from "./project-executions.js";

export function ProjectExecutionDetails({ project, stages, needsYou }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  if (!project.calls?.length) return null;
  const groups = expanded ? projectExecutions(project, stages, needsYou) : [];
  const taskUrl = cardId => `/?view=workflows&project=${encodeURIComponent(project.id)}&card=${encodeURIComponent(cardId)}`;
  return <>
    <button type="button" className="project-execution-toggle" aria-expanded={expanded} aria-controls={panelId}
      onClick={event => { event.stopPropagation(); setExpanded(value => !value); }} onKeyDown={event => event.stopPropagation()}>
      {expanded ? "收起详情" : "执行详情"}<ChevronDown size={13} aria-hidden="true" />
    </button>
    {expanded && <section className="project-execution-panel" id={panelId} aria-label="执行详情" onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
      {groups.map(group => {
        const { latest } = group;
        const state = executionState(latest);
        return <div className="project-execution-item" key={group.id}>
          <div className="project-execution-heading"><strong>{group.title}</strong><span className={`execution-state is-${state.tone}`}>{state.label}</span></div>
          <div className="project-execution-context">{group.itemTitle && <span>{group.itemTitle}</span>}{latest.iteration > 1 && <span>第 {latest.iteration} 轮</span>}{group.taskId && <a href={taskUrl(group.taskId)}>查看任务</a>}</div>
          {state.tone === "attention" && <p className="project-execution-reason">{executionReason(latest)}</p>}
          {group.history.length > 0 && <details className="project-execution-history"><summary>之前的 {group.history.length} 轮</summary>{[...group.history].reverse().map(round => <div key={round.id}><span>第 {round.iteration} 轮 · {executionState(round).label}</span><p>{executionReason(round)}</p></div>)}</details>}
          <details className="project-execution-record"><summary>执行记录</summary><p>本轮对外操作 {latest.operations ?? 0} 次，累计 {latest.totalOperations ?? 0}/{latest.maxOperations ?? 0} 次{latest.recoveryOperations > 0 ? `（含 ${latest.recoveryOperations} 次专用恢复许可）` : ""}</p><p>{executionReason(latest)}</p></details>
        </div>;
      })}
    </section>}
  </>;
}
