import React, { useEffect, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Film,
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
  Download,
  ExternalLink,
  FileText,
  Film,
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
          <button key={id} aria-label={label} title={label} className={active === id ? "active" : ""} onClick={() => onChange(id)}>
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
  const route = automation.contentRoute ?? findLabel(card, "route");
  return (
    <button className={`work-card status-${card.status}`} onClick={() => onClick(card)}>
      <div className="work-card-top"><StatusIcon status={card.status} /><span>{stage ?? "task"}</span>{route && route !== "—" && <span className="route-chip">{route}</span>}</div>
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

export function Drawer({ card, delivery, deliveryState, deliveryError, onClose, onDecide }) {
  const [reviewAction, setReviewAction] = useState(null);
  const [evidence, setEvidence] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  useEffect(() => {
    setReviewAction(null);
    setEvidence("");
    setSubmitting(false);
    setSubmitError("");
  }, [card?.id]);
  if (!card) return null;
  const automation = card.metadata?.automation ?? {};
  const approval = automation.approval;
  const canSubmit = reviewAction === "approve" || evidence.trim().length > 0;

  async function submitDecision() {
    if (!reviewAction || !canSubmit || submitting) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      await onDecide(card, reviewAction, evidence.trim() || "Reviewed in Workboard delivery panel");
    } catch (reason) {
      setSubmitError(reason.message);
      setSubmitting(false);
    }
  }

  return (
    <aside className="drawer">
      <div className="drawer-head"><div><span>项目交付</span><h2>{delivery?.title ?? card.title}</h2></div><button onClick={onClose} aria-label="关闭详情"><X size={18} /></button></div>
      <div className="drawer-status"><StatusIcon status={card.status} /><strong>{card.status}</strong><span>{card.id?.slice(0, 8)}</span></div>
      <DeliveryPanel delivery={delivery} state={deliveryState} error={deliveryError} showPlaceholder={card.status === "review"} />
      <section><h3>Execution</h3><Detail label="Agent" value={card.agentId ?? automation.agentRole ?? "—"} /><Detail label="Stage" value={automation.stageId ?? findLabel(card, "stage")} /><Detail label="Runtime" value={automation.maxRuntime ?? "—"} /><Detail label="Attempts" value={automation.maxAttempts ?? 1} /></section>
      {automation.contentItemId && <section><h3>视频任务</h3><Detail label="ContentItem" value={automation.contentItemId} mono /><Detail label="Route" value={automation.contentRoute ?? findLabel(card, "route")} /></section>}
      <section><h3>Live timeline</h3><ol className="timeline"><li className="done"><span />Card materialized in native Workboard</li><li className={card.status === "running" ? "active" : ""}><span />Waiting for the next runtime event</li></ol></section>
      <section><h3>Evidence & safety</h3><Detail label="Workflow SHA" value={automation.workflowSha256?.slice(0, 12) ?? "—"} mono /><Detail label="Input hash" value={automation.inputHash?.slice(0, 12) ?? "—"} mono /><Detail label="Idempotency" value={automation.nightshiftActionKey ? "protected" : "native card"} /></section>
      {card.notes && <section><h3>Operator notes</h3><pre>{card.notes}</pre></section>}
      {(card.status === "review" || approval) && <div className="review-zone">
        {!reviewAction && <div className="approval-actions"><button className="primary" onClick={() => setReviewAction("approve")}>通过</button><button onClick={() => setReviewAction("request-changes")}>要求修改</button><button className="danger" onClick={() => setReviewAction("reject")}>拒绝</button></div>}
        {reviewAction && <div className={`review-composer action-${reviewAction}`}>
          <div><strong>{decisionTitle(reviewAction)}</strong><span>{decisionHint(reviewAction)}</span></div>
          <textarea aria-label="审核意见" value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder={reviewAction === "approve" ? "审核备注（可选）" : "请写清楚需要修改或拒绝的原因"} />
          {submitError && <p className="decision-error">{submitError}</p>}
          <div className="review-confirm"><button onClick={() => { setReviewAction(null); setEvidence(""); }}>取消</button><button className={reviewAction === "reject" ? "danger" : "primary"} disabled={!canSubmit || submitting} onClick={submitDecision}>{submitting ? "提交中…" : "确认提交"}</button></div>
        </div>}
      </div>}
    </aside>
  );
}

function DeliveryPanel({ delivery, state, error, showPlaceholder }) {
  if (state === "loading") return <section className="delivery-panel delivery-loading"><div className="delivery-skeleton" /><span>正在载入交付内容…</span></section>;
  if (!delivery) {
    if (!showPlaceholder) return null;
    return <section className="delivery-panel delivery-empty"><Film size={20} /><div><strong>交付包尚未发布</strong><span>{error || "Agent 完成交付后，视频、提案与 QC 会显示在这里。"}</span></div></section>;
  }
  const videoMeta = [
    delivery.video.durationSeconds ? `${formatDuration(delivery.video.durationSeconds)}` : null,
    delivery.video.width && delivery.video.height ? `${delivery.video.width}×${delivery.video.height}` : null,
  ].filter(Boolean);
  return <section className="delivery-panel">
    <div className="delivery-heading"><div><span>DELIVERABLES</span><h3>交付内容</h3></div><span className={`qc-badge qc-${delivery.qc.status}`}><ShieldCheck size={13} />QC {delivery.qc.status === "passed" ? "通过" : delivery.qc.status}</span></div>
    <div className="video-frame">
      <video aria-label={delivery.video.title} controls playsInline preload="metadata" poster={delivery.video.posterUrl ?? undefined}>
        <source src={delivery.video.url} type={delivery.video.mimeType} />
      </video>
    </div>
    <div className="video-title"><div><strong>{delivery.video.title}</strong><span>{videoMeta.join(" · ")}</span></div><a href={delivery.video.url} download aria-label="下载成片"><Download size={16} /></a></div>
    <div className="delivery-links">
      {delivery.proposal.externalUrl && <a href={delivery.proposal.externalUrl} target="_blank" rel="noreferrer"><FileText size={15} /><span><strong>{delivery.proposal.title}</strong><small>打开策划案</small></span><ExternalLink size={13} /></a>}
      {delivery.video.projectUrl && <a href={delivery.video.projectUrl} target="_blank" rel="noreferrer"><Film size={15} /><span><strong>Makaron 工程</strong><small>打开可编辑项目</small></span><ExternalLink size={13} /></a>}
    </div>
    {delivery.proposal.summary && <details className="delivery-details"><summary>本轮执行摘要</summary><pre>{delivery.proposal.summary}</pre></details>}
    <details className="delivery-details qc-details"><summary>机器 QC 与技术报告 <span>{delivery.qc.summary.length} 项</span></summary>
      {delivery.qc.summary.length > 0 && <ul>{delivery.qc.summary.map((item) => <li key={item}>{item}</li>)}</ul>}
      {delivery.qc.report && <pre>{delivery.qc.report}</pre>}
    </details>
  </section>;
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

function formatDuration(seconds) {
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, "0")}`;
}

function decisionTitle(action) {
  if (action === "approve") return "确认通过本次交付";
  if (action === "request-changes") return "退回给 Agent 修改";
  return "拒绝本次交付";
}

function decisionHint(action) {
  if (action === "approve") return "只批准成片，不会触发外部发布。";
  if (action === "request-changes") return "意见会成为下一轮执行输入。";
  return "任务将进入 Blocked，保留全部交付证据。";
}
