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
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
  Workflow,
  X,
} from "lucide-react";
import { api } from "./api.js";

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
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Wrench,
  Workflow,
  X,
};

export function Sidebar({ active, collapsed, onChange, onToggle }) {
  const items = [
    ["board", "Live Board", LayoutDashboard],
    ["workflows", "Workflows", Workflow],
    ["projects", "Projects", GitBranch],
    ["agents", "Agents", Bot],
  ];
  return (
    <aside className={`sidebar ${collapsed ? "is-collapsed" : ""}`}>
      <div className="brand">
        <span className="brand-mark"><Sparkles size={17} /></span>
        <div><strong>Night Shift</strong><span>Powered by V</span></div>
        <button className="sidebar-toggle" aria-label={collapsed ? "展开主菜单" : "收起主菜单"} title={collapsed ? "展开主菜单" : "收起主菜单"} onClick={onToggle}>{collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}</button>
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
        <div><strong>V connected</strong><span>Workboard native</span></div>
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
  if (status === "scheduled") return <Clock3 size={14} />;
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
        <span><Clock3 size={13} />{card.status === "scheduled" && automation.scheduledAt
          ? formatRelease(automation.scheduledAt)
          : formatAge(card.updatedAt)}</span>
      </div>
      {automation.skills?.[0] && <div className="skill-line">{automation.skills[0]}</div>}
      <div className="work-card-foot"><span>{automation.instanceId ?? findLabel(card, "instance")}</span><ChevronRight size={14} /></div>
    </button>
  );
}

const DRAWER_STATUS = { blocked: "已阻塞", running: "进行中", review: "待审核", done: "已完成", ready: "待开始", todo: "待开始", scheduled: "定时待发", cancelled: "已取消" };

export function Drawer({ card, context = null, delivery, deliveryState, deliveryError, handoff, handoffState, handoffError, onClose, onDecide, onRetry }) {
  const [reviewAction, setReviewAction] = useState(null);
  const [evidence, setEvidence] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [sessionRunId, setSessionRunId] = useState(null);
  const [sessionData, setSessionData] = useState(null);
  const [sessionState, setSessionState] = useState("idle");
  const [sessionError, setSessionError] = useState("");
  const [sessionExpanded, setSessionExpanded] = useState(false);
  useEffect(() => {
    if (!card) return undefined;
    const onKey = (event) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card?.id, onClose]);
  const attempts = nativeCardAttempts(card);
  const selectedAttempt = attempts.find((attempt) => attempt.runId === sessionRunId) ?? attempts.at(-1);
  useEffect(() => {
    setReviewAction(null);
    setEvidence("");
    setSubmitting(false);
    setSubmitError("");
    const latestAttempt = nativeCardAttempts(card).at(-1);
    setSessionRunId(latestAttempt?.runId ?? null);
    setSessionData(null);
    setSessionState(latestAttempt ? "loading" : "idle");
    setSessionError("");
    setSessionExpanded(false);
  }, [card?.id]);
  useEffect(() => {
    if (!card?.id || !selectedAttempt?.runId || !sessionExpanded) return undefined;
    let active = true;
    const load = async (quiet = false) => {
      if (!quiet) {
        setSessionData(null);
        setSessionState("loading");
      }
      try {
        const result = await api(`/api/cards/${encodeURIComponent(card.id)}/session?runId=${encodeURIComponent(selectedAttempt.runId)}`);
        if (!active) return;
        setSessionData(result);
        setSessionError("");
        setSessionState("ready");
      } catch (reason) {
        if (!active) return;
        setSessionError(reason.message);
        setSessionState("error");
      }
    };
    load();
    return () => {
      active = false;
    };
  }, [card?.id, selectedAttempt?.runId, selectedAttempt?.status, sessionExpanded]);
  if (!card) return null;
  const automation = card.metadata?.automation ?? {};
  const approval = automation.approval;
  const publicationApproval = approval?.effect === "external-publication";
  const approvalIncomplete = (approval?.missingFields?.length ?? 0) > 0;
  const canSubmit = (reviewAction !== "approve" || !approvalIncomplete) && (reviewAction === "approve" || evidence.trim().length > 0);

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
      <div className="drawer-head"><div><span>{[context?.projectName, context?.stageTitle].filter(Boolean).join(" · ") || "任务详情"}</span><h2>{context?.contentTitle ?? delivery?.title ?? card.title}</h2></div><button onClick={onClose} aria-label="关闭详情"><X size={18} /></button></div>
      <DrawerNow card={card} attention={context?.attention} attempts={attempts} />
      {card.status === "blocked" && !approval && <div className="review-zone drawer-actions"><button className="primary" disabled={submitting} onClick={async () => { setSubmitting(true); try { await onRetry(card); } catch (reason) { setSubmitError(reason.message); setSubmitting(false); } }}>{submitting ? "重新排队中…" : "修正后重新执行"}</button><span>{context?.attention?.kind === "healing" ? "它正在自己恢复，一般不需要重试；重试付费任务可能重复扣费。" : "先处理好原因，再让 Agent 重新做这一步。"}</span>{submitError && <p className="decision-error">{submitError}</p>}</div>}
      <StageHandoffPanel handoff={handoff} state={handoffState} error={handoffError} delivery={delivery} deliveryState={deliveryState} deliveryError={deliveryError} />
      {(automation.skills?.length ?? 0) > 0 && <section className="stage-skills"><h3>这一步用到的能力</h3><div>{automation.skills.map((skill) => <span key={skill}><Wrench size={11} />{skill}</span>)}</div></section>}
      <NativeWorkboardActivity card={card} />
      {attempts.length > 0 && <AgentSessionPanel
        attempts={attempts}
        data={sessionData}
        error={sessionError}
        expanded={sessionExpanded}
        onExpandedChange={setSessionExpanded}
        onRefresh={async () => {
          if (!selectedAttempt?.runId || sessionState === "loading") return;
          setSessionState("loading");
          try {
            const result = await api(`/api/cards/${encodeURIComponent(card.id)}/session?runId=${encodeURIComponent(selectedAttempt.runId)}`);
            setSessionData(result);
            setSessionError("");
            setSessionState("ready");
          } catch (reason) {
            setSessionError(reason.message);
            setSessionState("error");
          }
        }}
        onSelect={(runId) => {
          setSessionRunId(runId);
          setSessionData(null);
          setSessionError("");
        }}
        selected={selectedAttempt}
        state={sessionState}
      />}
      <details className="drawer-tech"><summary>技术信息</summary>
        <Detail label="执行 Agent" value={card.agentId ?? automation.agentRole ?? "—"} />
        <Detail label="阶段" value={automation.stageId ?? findLabel(card, "stage")} mono />
        {automation.contentItemId && <Detail label="内容编号" value={automation.contentItemId} mono />}
        {(automation.contentRoute ?? findLabel(card, "route")) !== "—" && <Detail label="路线" value={automation.contentRoute ?? findLabel(card, "route")} />}
        <Detail label="尝试次数" value={attempts.length} />
        <Detail label="卡片编号" value={card.id} mono />
        <Detail label="Workflow 版本" value={automation.workflowSha256?.slice(0, 12) ?? "—"} mono />
        <Detail label="输入指纹" value={automation.inputHash?.slice(0, 12) ?? "—"} mono />
        <Detail label="防重复提交" value={automation.idempotencyKey || automation.nightshiftActionKey ? "已启用" : "原生卡片"} />
      </details>
      {approval && <section className="publication-approval"><h3>执行确认</h3><p>{publicationApproval ? "本次确认包含外部发布授权；确认后任务才会进入发布步骤。" : "这个阶段需要明确授权后才能继续；确认后任务会进入执行队列。"}</p><Detail label="权限" value={publicationApproval ? "外部发布" : approval.effect} /><Detail label="范围" value={approval.scope ?? "stage"} />{Object.entries(approval.bindings ?? {}).map(([name, value]) => <Detail key={name} label={name === "publicationTarget" ? "发布目标" : name} value={presentApprovalBinding(value)} />)}{approvalIncomplete && <p className="decision-error">发布前还缺少：{approval.missingFields.join("、")}</p>}</section>}
      {card.notes && <details className="drawer-tech"><summary>给 Agent 的任务说明</summary><pre>{card.notes}</pre></details>}
      {(card.status === "review" || approval) && <div className="review-zone">
        {!reviewAction && (approval ? <div className="approval-actions approval-actions-two"><button className="primary" onClick={() => setReviewAction("approve")}>确认执行</button><button className="danger" onClick={() => setReviewAction("reject")}>暂不执行</button></div> : <div className="approval-actions"><button className="primary" onClick={() => setReviewAction("approve")}>通过</button><button onClick={() => setReviewAction("request-changes")}>要求修改</button><button className="danger" onClick={() => setReviewAction("reject")}>拒绝</button></div>)}
        {reviewAction && <div className={`review-composer action-${reviewAction}`}>
          <div><strong>{approval ? executionDecisionTitle(reviewAction) : decisionTitle(reviewAction)}</strong><span>{approval ? executionDecisionHint(reviewAction, publicationApproval) : decisionHint(reviewAction)}</span></div>
          <textarea aria-label="审核意见" value={evidence} onChange={(event) => setEvidence(event.target.value)} placeholder={approval ? "执行备注（可选）" : reviewAction === "approve" ? "审核备注（可选）" : "请写清楚需要修改或拒绝的原因"} />
          {submitError && <p className="decision-error">{submitError}</p>}
          <div className="review-confirm"><button onClick={() => { setReviewAction(null); setEvidence(""); }}>取消</button><button className={reviewAction === "reject" ? "danger" : "primary"} disabled={!canSubmit || submitting} onClick={submitDecision}>{submitting ? "提交中…" : "确认提交"}</button></div>
        </div>}
      </div>}
    </aside>
  );
}

const NOW_TITLES = { running: "Agent 正在做", queued: "排队等待开始", done: "这一步已完成", stale: "项目已搁置，这张卡只供翻看" };

// What a person needs first: where this task stands and the latest thing
// that happened, in plain words.
function DrawerNow({ card, attention, attempts }) {
  const kind = attention?.kind ?? ({ running: "running", done: "done", blocked: "needs-you", review: "needs-you" })[card.status] ?? "queued";
  const title = attention?.reason ?? NOW_TITLES[kind] ?? DRAWER_STATUS[card.status] ?? card.status;
  const latest = nativeActivityItems(card).filter((item) => item.body && item.tone !== "heartbeat").at(-1);
  const current = attempts.at(-1);
  const facts = [
    card.agentId ? `由 ${card.agentId} 负责` : null,
    attempts.length ? `第 ${attempts.length} 次尝试` : null,
    current?.startedAt ? `${current.endedAt ? "用时" : "已进行"} ${formatAttemptDuration(current)}` : null,
  ].filter(Boolean);
  return <section className={`drawer-now attention-${kind}`}>
    <div className="drawer-now-head"><StatusIcon status={card.status} /><strong>{title}</strong></div>
    {latest && <div className="drawer-now-latest"><span>最新进展 · {formatRelative(latest.timestamp)}</span><p>{latest.body}</p></div>}
    {facts.length > 0 && <small>{facts.join(" · ")}</small>}
  </section>;
}

function formatRelative(value) {
  const at = finiteNumber(value);
  if (!at) return "";
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`;
  return new Date(at).toLocaleString();
}

function StageHandoffPanel({ handoff, state, error, delivery, deliveryState, deliveryError }) {
  if (state === "loading") return <section className="handoff-panel handoff-loading"><div className="delivery-skeleton" /><span>正在载入阶段输入与输出…</span></section>;
  if (!handoff) return <section className="handoff-panel handoff-empty"><AlertTriangle size={17} /><span>{error || "这张卡没有可用的阶段交接信息。"}</span></section>;
  const previous = handoff.previous?.length ? handoff.previous.map((entry) => entry.title).join("、") : "项目输入";
  const next = handoff.next?.length ? handoff.next.map((entry) => entry.title).join("、") : "流程结束";
  return <section className="handoff-panel">
    <div className="handoff-flow" aria-label="阶段流转"><span>{previous}</span><ChevronRight size={13} /><strong>{handoff.stage.title}</strong><ChevronRight size={13} /><span>{next}</span></div>
    {!handoff.recorded && <div className="handoff-legacy">历史任务：按 Workflow 推导输入与输出；新任务会记录实际交接摘要。</div>}
    <HandoffGroup title="上一步交来的" entries={handoff.inputs} />
    {handoff.deliveryPlacement === "input" && <DeliveryPanel delivery={delivery} state={deliveryState} error={deliveryError} showPlaceholder contextLabel="本阶段输入" />}
    <HandoffGroup title="这一步产出的" entries={handoff.outputs} />
    {handoff.deliveryPlacement === "output" && <DeliveryPanel delivery={delivery} state={deliveryState} error={deliveryError} showPlaceholder contextLabel="本阶段输出" />}
  </section>;
}

function HandoffGroup({ entries = [], title }) {
  return <div className="handoff-group"><h3>{title}</h3>{entries.length > 0 ? <div className="handoff-items">{entries.map((entry) => <article key={`${entry.sourceStage}:${entry.name}`} className={`handoff-item state-${entry.status}`}><div><strong>{humanArtifactName(entry.name)}</strong><span>{entry.sourceStage}</span></div>{entry.summary && <p>{entry.summary}</p>}{entry.artifactUrl ? <a className="handoff-artifact-link" href={entry.artifactUrl} target="_blank" rel="noreferrer"><span>{entry.name === "publicUrl" ? "打开发布页面" : "查看交付证据"}</span><ExternalLink size={12} /></a> : <small className={entry.name === "publicUrl" && entry.status === "completed-unregistered" ? "missing-publication-link" : ""}>{entry.artifact ? entry.artifact.split("/").at(-1) : entry.name === "publicUrl" && entry.status === "completed-unregistered" ? "未登记实际发布链接" : entry.status === "completed-unregistered" ? "阶段已完成 · 未登记交接摘要" : "等待阶段产出"}</small>}</article>)}</div> : <p className="handoff-none">没有上一步；本阶段直接使用项目输入。</p>}</div>;
}

function humanArtifactName(name) {
  const labels = {
    approvedAssetVersion: "已批准版本",
    contentItemsManifest: "内容任务清单",
    deliveryManifest: "交付清单",
    finishedAsset: "最终成片",
    finishedVideoBrief: "成片 Brief",
    frozenInputManifest: "冻结输入清单",
    machineQc: "机器 QC",
    materialReadiness: "素材准备结果",
    metricsSnapshot: "数据快照",
    planUrl: "策划案",
    publicationEvidence: "发布证据",
    publishTask: "发布任务",
    publicUrl: "公开链接",
    requirementSnapshot: "需求快照",
    retrospective: "复盘建议",
    routeDecision: "路线判断",
  };
  return labels[name] ?? name;
}

function presentApprovalBinding(value) {
  if (!value || typeof value !== "object") return String(value ?? "—");
  const preferred = [value.tiktokHandle, value.platform, value.market, value.language, value.geelarkDeviceId].filter(Boolean);
  if (preferred.length > 0) return preferred.join(" · ");
  return Object.entries(value).map(([key, entry]) => `${key}: ${String(entry)}`).join(" · ");
}

function NativeWorkboardActivity({ card }) {
  const items = nativeActivityItems(card);
  return <details className="drawer-tech native-activity"><summary>全部记录<span>{items.length}</span></summary>{items.length > 0 ? <ol>{[...items].reverse().slice(0, 40).map((item) => <li key={item.key}><span className={`activity-dot tone-${item.tone}`} /><div><strong>{item.title}</strong><small>{formatDateTime(item.timestamp)}</small>{item.body && <p>{item.body}</p>}</div></li>)}</ol> : <p className="native-empty">这张卡还没有运行记录。</p>}</details>;
}

const EVENT_TITLES = { created: "卡片创建", dispatch: "派给 Agent", moved: "状态变化", heartbeat: "心跳", execution_updated: "执行信息更新", link_added: "关联项目", linked: "关联项目", orchestration: "引擎编排", released: "释放", claimed: "Agent 认领" };

function AgentSessionPanel({ attempts, data, error, expanded, onExpandedChange, onRefresh, onSelect, selected, state }) {
  return <section className="agent-session-panel"><button className="drawer-section-toggle" aria-expanded={expanded} onClick={() => onExpandedChange(!expanded)}><span>Agent 对话</span><small>{expanded ? "收起" : `查看 ${attempts.length} 次尝试的过程`}</small></button>{expanded && <>
    <div className="attempt-tabs" role="tablist" aria-label="Session attempts">{attempts.map((attempt) => <button role="tab" aria-selected={attempt.runId === selected?.runId} className={attempt.runId === selected?.runId ? "selected" : ""} key={attempt.runId} onClick={() => onSelect(attempt.runId)}><span>第 {attempt.index} 次</span><small>{sessionStatusLabel(attempt.status)}</small></button>)}</div>
    {selected && <div className="session-meta"><span><b>{selected.engine}</b> · {selected.model}</span><span>{formatAttemptDuration(selected)}</span><button aria-label="刷新 Agent Session" disabled={state === "loading"} onClick={onRefresh}><RefreshCw size={12} /></button></div>}
    <div className={`session-transcript state-${state}`}>
      {state === "loading" && !data && <div className="session-loading"><span className="delivery-skeleton" />正在读取 Agent Session…</div>}
      {error && <div className="session-error">{error}</div>}
      {state !== "loading" && !error && (data?.messages?.length ?? 0) === 0 && <div className="native-empty">这个 Attempt 尚无可显示的消息。</div>}
      {(data?.messages ?? []).map((message, index) => <SessionMessage key={`${message.timestamp ?? "message"}-${index}`} message={message} />)}
    </div>
    {selected?.error && <details className="attempt-error"><summary>本次阻塞原因</summary><p>{selected.error}</p></details>}
  </>}</section>;
}

function SessionMessage({ message }) {
  const parts = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];
  const roleLabel = message.role === "assistant" ? "Agent" : message.role === "toolResult" ? `Tool · ${message.toolName ?? "result"}` : message.role === "user" ? "Task" : message.role;
  return <article className={`session-message role-${message.role} ${message.isError ? "is-error" : ""}`}><header><strong>{roleLabel}</strong><span>{formatDateTime(message.timestamp)}</span></header><div>{parts.map((part, index) => <SessionPart key={`${part?.type ?? "part"}-${index}`} part={part} />)}</div></article>;
}

function SessionPart({ part }) {
  if (typeof part === "string") return <p>{part}</p>;
  if (part?.type === "toolCall") return <details className="session-tool-call"><summary><Wrench size={12} />{part.name ?? "tool"}</summary>{part.arguments && <pre>{JSON.stringify(part.arguments, null, 2)}</pre>}</details>;
  if (part?.type === "text" || part?.text) return <p>{part.text}</p>;
  return <div className="session-structured"><span>{part?.type ?? "content"}</span><pre>{JSON.stringify(part, null, 2)}</pre></div>;
}

function DeliveryPanel({ delivery, state, error, showPlaceholder, contextLabel = "交付内容" }) {
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
    <div className="delivery-heading"><div><span>DELIVERABLE</span><h3>{contextLabel}</h3></div><span className={`qc-badge qc-${delivery.qc.status}`}><ShieldCheck size={13} />QC {delivery.qc.status === "passed" ? "通过" : delivery.qc.status}</span></div>
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

function nativeCardAttempts(card) {
  if (!card) return [];
  const attempts = Array.isArray(card.metadata?.attempts) ? card.metadata.attempts : [];
  const candidates = attempts.length > 0 ? attempts : [card.execution ?? card];
  return candidates.filter((attempt) => attempt?.sessionKey).map((attempt, index) => ({
    endedAt: finiteNumber(attempt.endedAt),
    engine: attempt.engine ?? "openclaw",
    error: attempt.error ?? null,
    index: index + 1,
    model: attempt.model ?? "default",
    runId: attempt.runId ?? attempt.id ?? card.runId ?? `attempt-${index + 1}`,
    sessionKey: attempt.sessionKey ?? card.sessionKey,
    startedAt: finiteNumber(attempt.startedAt),
    status: attempt.status ?? card.status ?? "unknown",
  })).sort((left, right) => Number(left.startedAt ?? 0) - Number(right.startedAt ?? 0));
}

function nativeActivityItems(card) {
  if (!card) return [];
  const items = [];
  const push = (kind, timestamp, title, body = "", tone = "default", id = "") => {
    if (!timestamp && !title) return;
    items.push({ body: String(body ?? ""), key: `${kind}-${id || timestamp || items.length}`, timestamp: finiteNumber(timestamp), title, tone });
  };
  push("created", card.createdAt, "卡片创建", "", "done", card.id);
  const claim = card.metadata?.claim;
  if (claim?.claimedAt) push("claim", claim.claimedAt, `${claim.ownerId ?? card.agentId ?? "Agent"} 认领了任务`, "", "active", claim.ownerId);
  if (claim?.lastHeartbeatAt) push("heartbeat", claim.lastHeartbeatAt, "最近一次心跳", "", "heartbeat", "latest");
  for (const attempt of nativeCardAttempts(card)) {
    push("attempt-start", attempt.startedAt, `第 ${attempt.index} 次尝试开始`, `${attempt.model}`, "active", attempt.runId);
    if (attempt.endedAt) push("attempt-end", attempt.endedAt, `第 ${attempt.index} 次尝试${sessionStatusLabel(attempt.status)}`, attempt.error ?? "", attempt.status === "done" ? "done" : attempt.status === "running" ? "active" : "error", attempt.runId);
  }
  for (const entry of card.metadata?.comments ?? []) push("comment", entry.createdAt, "Agent 留言", entry.body, "comment", entry.id);
  for (const entry of card.metadata?.workerLogs ?? []) push("worker", entry.createdAt, entry.level === "error" ? "运行错误" : "运行日志", entry.message, entry.level === "error" ? "error" : "active", entry.id);
  for (const entry of card.metadata?.notifications ?? []) push("notification", entry.createdAt, "通知", entry.message, entry.kind === "failed" ? "error" : "default", entry.id);
  for (const entry of card.events ?? []) {
    const type = entry.type ?? entry.kind;
    if (type === "heartbeat") continue;
    const moved = type === "moved" && entry.toStatus ? `${DRAWER_STATUS[entry.fromStatus] ?? entry.fromStatus ?? ""} → ${DRAWER_STATUS[entry.toStatus] ?? entry.toStatus}` : "";
    push("event", entry.createdAt ?? entry.timestamp ?? entry.at, EVENT_TITLES[type] ?? type ?? "看板事件", moved || entry.message || entry.body || "", entry.status === "failed" || entry.toStatus === "blocked" ? "error" : "default", entry.id);
  }
  const unique = new Map();
  for (const item of items.sort((left, right) => Number(left.timestamp ?? 0) - Number(right.timestamp ?? 0))) {
    const key = `${item.timestamp}:${item.title}:${item.body}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()];
}

function sessionStatusLabel(status) {
  return ({ blocked: "已阻塞", done: "已完成", failed: "失败", running: "运行中", timeout: "超时" })[status] ?? status ?? "未知";
}

function formatAttemptDuration(attempt) {
  if (!attempt?.startedAt) return "—";
  const milliseconds = Math.max(0, Number(attempt.endedAt ?? Date.now()) - Number(attempt.startedAt));
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function formatDateTime(value) {
  const timestamp = finiteNumber(value);
  return timestamp ? new Date(timestamp).toLocaleString() : "—";
}

function finiteNumber(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// A held card's useful fact is when it goes out, not how long ago it was
// touched. Rendered in the viewer's own zone, since the release moment is an
// absolute instant and the operator is rarely in the target market.
function formatRelease(at) {
  const when = new Date(at);
  if (Number.isNaN(when.valueOf())) return "scheduled";
  const sameDay = when.toDateString() === new Date().toDateString();
  return when.toLocaleString(undefined, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
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

function executionDecisionTitle(action) {
  return action === "approve" ? "确认继续执行这个阶段" : "暂不执行这个阶段";
}

function executionDecisionHint(action, publicationApproval = false) {
  if (action !== "approve") return "任务继续保持阻塞，交付内容不会被删除。";
  return publicationApproval ? "确认包含外部发布授权，任务随后重新进入执行队列。" : "确认后任务会重新进入执行队列。";
}
