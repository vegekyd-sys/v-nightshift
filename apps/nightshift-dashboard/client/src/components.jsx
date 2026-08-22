import React from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  FileCode2,
  GitBranch,
  LayoutDashboard,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";

export const Icons = {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  Clock3,
  FileCode2,
  GitBranch,
  LayoutDashboard,
  Play,
  Search,
  ShieldCheck,
  Sparkles,
  Workflow,
  X,
};

export function Sidebar({ active, onChange }) {
  const items = [
    ["board", "Live Board", LayoutDashboard],
    ["workflows", "Workflows", Workflow],
    ["projects", "Projects", GitBranch],
    ["agents", "Agents", Bot],
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark"><Sparkles size={17} /></span>
        <div><strong>Night Shift</strong><span>AI operations</span></div>
      </div>
      <nav>
        {items.map(([id, label, Icon]) => (
          <button key={id} className={active === id ? "active" : ""} onClick={() => onChange(id)}>
            <Icon size={17} /><span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <span className="live-dot" />
        <div><strong>VLab connected</strong><span>Workboard native</span></div>
      </div>
    </aside>
  );
}

export function Metric({ label, value, tone = "default" }) {
  return <div className={`metric metric-${tone}`}><strong>{value}</strong><span>{label}</span></div>;
}

export function StatusIcon({ status }) {
  if (status === "done") return <Check size={14} />;
  if (status === "blocked") return <AlertTriangle size={14} />;
  if (status === "running") return <Activity size={14} />;
  if (status === "review") return <ShieldCheck size={14} />;
  return <CircleDot size={14} />;
}

export function WorkCard({ card, onClick }) {
  const automation = card.metadata?.automation ?? {};
  const stage = card.labels?.find((label) => label.startsWith("stage:"))?.slice(6);
  return (
    <button className={`work-card status-${card.status}`} onClick={() => onClick(card)}>
      <div className="work-card-top"><StatusIcon status={card.status} /><span>{stage ?? "task"}</span></div>
      <h3>{card.title}</h3>
      <div className="work-card-meta">
        <span><Bot size={13} />{card.agentId ?? automation.agentRole ?? "unassigned"}</span>
        <span><Clock3 size={13} />{formatAge(card.updatedAt)}</span>
      </div>
      {automation.skills?.[0] && <div className="skill-line">{automation.skills[0]}</div>}
      <div className="work-card-foot"><span>{automation.instanceId ?? findLabel(card, "instance")}</span><ChevronRight size={14} /></div>
    </button>
  );
}

export function Drawer({ card, onClose, onApprove, onRequestChanges, onReject }) {
  if (!card) return null;
  const automation = card.metadata?.automation ?? {};
  const approval = automation.approval;
  return (
    <aside className="drawer">
      <div className="drawer-head"><div><span>Task detail</span><h2>{card.title}</h2></div><button onClick={onClose} aria-label="Close detail"><X size={18} /></button></div>
      <div className="drawer-status"><StatusIcon status={card.status} /><strong>{card.status}</strong><span>{card.id?.slice(0, 8)}</span></div>
      <section><h3>Execution</h3><Detail label="Agent" value={card.agentId ?? automation.agentRole ?? "—"} /><Detail label="Stage" value={automation.stageId ?? findLabel(card, "stage")} /><Detail label="Runtime" value={automation.maxRuntime ?? "—"} /><Detail label="Attempts" value={automation.maxAttempts ?? 1} /></section>
      <section><h3>Live timeline</h3><ol className="timeline"><li className="done"><span />Card materialized in native Workboard</li><li className={card.status === "running" ? "active" : ""}><span />Waiting for the next runtime event</li></ol></section>
      <section><h3>Evidence & safety</h3><Detail label="Workflow SHA" value={automation.workflowSha256?.slice(0, 12) ?? "—"} mono /><Detail label="Input hash" value={automation.inputHash?.slice(0, 12) ?? "—"} mono /><Detail label="Idempotency" value={automation.nightshiftActionKey ? "protected" : "native card"} /></section>
      {card.notes && <section><h3>Operator notes</h3><pre>{card.notes}</pre></section>}
      {(card.status === "review" || approval) && <div className="approval-actions"><button className="primary" onClick={() => onApprove(card)}>Approve</button><button onClick={() => onRequestChanges(card)}>Request changes</button><button className="danger" onClick={() => onReject(card)}>Reject</button></div>}
    </aside>
  );
}

export function Detail({ label, value, mono = false }) {
  return <div className="detail-row"><span>{label}</span><strong className={mono ? "mono" : ""}>{String(value ?? "—")}</strong></div>;
}

export function EmptyColumn() {
  return <div className="empty-column"><span /><p>No work in this state</p></div>;
}

function findLabel(card, prefix) {
  return card.labels?.find((label) => label.startsWith(`${prefix}:`))?.split(":").slice(1).join(":") ?? "—";
}

function formatAge(value) {
  if (!value) return "now";
  const ms = Date.now() - new Date(value).getTime();
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}
