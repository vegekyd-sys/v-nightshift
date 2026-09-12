import { ExecutionControls } from "./ExecutionControls.jsx";
import React, { useEffect, useMemo, useRef, useState } from "react";
import YAML from "yaml";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FilePenLine,
  FileUp,
  MoreHorizontal,
  Plus,
  Save,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { api } from "./api.js";
import { Drawer, EmptyColumn, Icons, Metric, Sidebar, WorkCard } from "./components.jsx";

const columns = [
  ["ready", "Ready", ["triage", "backlog", "todo", "planned", "ready"]],
  ["running", "Running", ["running"]],
  ["review", "Review", ["review"]],
  ["blocked", "Blocked", ["blocked"]],
  ["done", "Done", ["done"]],
];

export function App() {
  const initialLocation = useRef(readDashboardLocation()).current;
  const deepLinkApplied = useRef(false);
  const [active, setActive] = useState(initialLocation.view);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [deliveryState, setDeliveryState] = useState("idle");
  const [deliveryError, setDeliveryError] = useState("");
  const [handoff, setHandoff] = useState(null);
  const [handoffState, setHandoffState] = useState("idle");
  const [handoffError, setHandoffError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [projectReleaseSha, setProjectReleaseSha] = useState(null);
  const [workflowProjectId, setWorkflowProjectId] = useState(initialLocation.project);
  const [navigationCollapsed, setNavigationCollapsed] = useState(() => typeof window !== "undefined" && window.localStorage.getItem("nightshift.navigationCollapsed") === "true");
  const refreshInFlight = useRef(null);
  const selectedForDecision = useMemo(() => withDecisionContext(selected, data), [selected, data]);

  function refresh(force = false) {
    if (refreshInFlight.current) return refreshInFlight.current;
    setRefreshing(true);
    const request = api(force ? "/api/bootstrap?refresh=1" : "/api/bootstrap")
      .then((result) => { setData(result); setError(""); return result; })
      .catch((reason) => { setError(reason.message); throw reason; })
      .finally(() => { setRefreshing(false); refreshInFlight.current = null; });
    refreshInFlight.current = request;
    return request;
  }

  useEffect(() => {
    refresh(false).catch(() => undefined);
    const timer = setInterval(() => refresh(false).catch(() => undefined), 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    updateDashboardLocation({ view: active });
  }, [active]);

  useEffect(() => {
    window.localStorage.setItem("nightshift.navigationCollapsed", String(navigationCollapsed));
  }, [navigationCollapsed]);

  useEffect(() => {
    if (!data || deepLinkApplied.current) return;
    if (initialLocation.card) {
      const card = (data.cards ?? []).find((entry) => entry.id === initialLocation.card);
      if (card) setSelected(card);
    }
    deepLinkApplied.current = true;
  }, [data, initialLocation.card]);

  useEffect(() => {
    if (!data || !deepLinkApplied.current) return;
    updateDashboardLocation({ card: selected?.id ?? null });
  }, [data, selected?.id]);

  useEffect(() => {
    const instanceId = selected ? cardLabel(selected, "instance") : null;
    const contentItemId = selected?.metadata?.automation?.contentItemId ?? (selected ? label(selected, "content-item") : null);
    const stageId = selected?.metadata?.automation?.stageId ?? (selected ? label(selected, "stage") : null);
    if (!instanceId || !stageId) {
      setDelivery(null);
      setDeliveryState("idle");
      setDeliveryError("");
      setHandoff(null);
      setHandoffState("idle");
      setHandoffError("");
      return undefined;
    }
    let current = true;
    setDelivery(null);
    setDeliveryState("idle");
    setDeliveryError("");
    setHandoff(null);
    setHandoffState("loading");
    setHandoffError("");
    const query = contentItemId ? `?contentItemId=${encodeURIComponent(contentItemId)}` : "";
    api(`/api/instances/${encodeURIComponent(instanceId)}/stages/${encodeURIComponent(stageId)}/handoff${query}`)
      .then(async (result) => {
        if (!current) return;
        setHandoff(result);
        setHandoffState("ready");
        if (!result.deliveryPlacement) return;
        setDeliveryState("loading");
        const deliveryPath = contentItemId
          ? `/api/instances/${encodeURIComponent(instanceId)}/content-items/${encodeURIComponent(contentItemId)}/deliverables`
          : `/api/instances/${encodeURIComponent(instanceId)}/deliverables`;
        try {
          const deliveryResult = await api(deliveryPath);
          if (!current) return;
          setDelivery(deliveryResult);
          setDeliveryState("ready");
        } catch (reason) {
          if (!current) return;
          setDeliveryError(reason.message);
          setDeliveryState("missing");
        }
      })
      .catch((reason) => {
        if (!current) return;
        setHandoffError(reason.message);
        setHandoffState("error");
      });
    return () => { current = false; };
  }, [selected?.id]);

  async function decide(card, status, evidence) {
    const automation = card.metadata?.automation ?? {};
    const instanceId = automation.instanceId ?? cardLabel(card, "instance");
    const contentItemId = automation.contentItemId ?? label(card, "content-item");
    const stageId = automation.stageId ?? label(card, "stage");
    const approval = automation.approval;
    const decisionCardId = automation.decisionCardId ?? card.id;
    try {
      await api(`/api/cards/${decisionCardId}/${status}`, {
        method: "POST",
        body: JSON.stringify({ actor: "Workboard operator", contentItemId, effect: approval?.effect, evidence, instanceId, scope: approval?.scope, stageId }),
      });
      setSelected(null);
      await refresh();
    } catch (reason) {
      setError(reason.message);
      throw reason;
    }
  }

  async function retry(card) {
    const instanceId = cardLabel(card, "instance");
    const contentItemId = card.metadata?.automation?.contentItemId ?? label(card, "content-item");
    const stageId = card.metadata?.automation?.stageId ?? label(card, "stage");
    await api(`/api/cards/${card.id}/retry`, {
      method: "POST",
      body: JSON.stringify({ actor: "Workboard operator", contentItemId, evidence: "Retry requested from Workboard", instanceId, stageId }),
    });
    setSelected(null);
    await refresh();
  }

  return (
    <div className={`app-shell ${navigationCollapsed ? "navigation-collapsed" : ""}`}>
      <Sidebar active={active} collapsed={navigationCollapsed} onChange={setActive} onToggle={() => setNavigationCollapsed((value) => !value)} />
      <main className="main-shell">
        {error && <div className="error-banner">{error}</div>}
        {active === "board" && <LiveBoard data={data} query={query} setQuery={setQuery} selected={selectedForDecision} setSelected={setSelected} refreshing={refreshing} refresh={refresh} decide={decide} retry={retry} delivery={delivery} deliveryState={deliveryState} deliveryError={deliveryError} handoff={handoff} handoffState={handoffState} handoffError={handoffError} />}
        {active === "workflows" && <WorkflowStudio data={data} refresh={refresh} initialProjectId={workflowProjectId} initialWorkflowId={initialLocation.workflow} setSelected={setSelected} selected={selectedForDecision} decide={decide} approveMany={approveMany} retry={retry} delivery={delivery} deliveryState={deliveryState} deliveryError={deliveryError} handoff={handoff} handoffState={handoffState} handoffError={handoffError} onNewProject={(release) => setProjectReleaseSha(release?.workflowSha256 ?? data?.workflows?.[0]?.workflowSha256)} />}
        {active === "projects" && <Projects data={data} refresh={refresh} onNewProject={() => setProjectReleaseSha(data?.workflows?.[0]?.workflowSha256)} onOpenProject={(projectId) => { setWorkflowProjectId(projectId); updateDashboardLocation({ project: projectId, view: "workflows" }); setActive("workflows"); }} />}
        {active === "agents" && <Agents data={data} />}
      </main>
      {projectReleaseSha && <ProjectEditor releases={data?.workflows ?? []} initialReleaseSha={projectReleaseSha} onClose={() => setProjectReleaseSha(null)} onCreated={(result) => { setProjectReleaseSha(null); setActive("projects"); if (result.initialScheduleError) setError(`项目已创建，首次调度将在下一轮重试：${result.initialScheduleError}`); refresh(true).catch((reason) => setError(reason.message)); }} />}
    </div>
  );

  async function approveMany(cards, evidence) {
    const result = await api("/api/cards/bulk/approve", {
      method: "POST",
      body: JSON.stringify({ actor: "Workboard operator", cardIds: cards.map((card) => card.id), evidence }),
    });
    if (!result.ok) throw new Error(`已通过 ${result.approved} 条，另有 ${result.failed} 条失败，请刷新后重试`);
    await refresh(true);
    return result;
  }
}

function LiveBoard({ data, query, setQuery, selected, setSelected, refreshing, refresh, decide, retry, delivery, deliveryState, deliveryError, handoff, handoffState, handoffError }) {
  const cards = useMemo(() => (data?.cards ?? []).filter((card) => !query || card.title.toLowerCase().includes(query.toLowerCase())), [data, query]);
  const count = (statuses) => cards.filter((card) => statuses.includes(card.status)).length;
  const [mobileColumn, setMobileColumn] = useState("running");
  return <>
    <header className="topbar"><div><span className="section-label">Night Shift operations</span><h1>Live Workboard</h1></div><div className="top-actions"><label className="search"><Icons.Search size={16} /><input aria-label="Search cards" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search work" /></label><button onClick={() => refresh(true)} className="refresh-button">{refreshing ? "Refreshing…" : "Refresh"}</button></div></header>
    <section className="metrics"><Metric label="Active agents" value={count(["running"])} tone="active" /><Metric label="Waiting review" value={count(["review"])} tone="review" /><Metric label="Blocked" value={count(["blocked"])} tone="blocked" /><Metric label="Completed" value={count(["done"])} /></section>
    <nav className="mobile-board-tabs" aria-label="任务状态">{columns.map(([id, title, statuses]) => <button className={mobileColumn === id ? "active" : ""} key={id} onClick={() => setMobileColumn(id)}><span>{title}</span><strong>{count(statuses)}</strong></button>)}</nav>
    <section className={`board ${selected ? "with-drawer" : ""}`}>
      <div className="board-columns">{columns.map(([id, title, statuses]) => { const items = cards.filter((card) => statuses.includes(card.status)); return <div className={`board-column column-${id} ${mobileColumn === id ? "mobile-active" : ""}`} key={id}><div className="column-head"><h2>{title}</h2><span>{items.length}</span></div><div className="column-body">{items.map((card) => <WorkCard key={card.id} card={card} onClick={setSelected} />)}{items.length === 0 && <EmptyColumn />}</div></div>; })}</div>
      <Drawer card={selected} delivery={delivery} deliveryState={deliveryState} deliveryError={deliveryError} handoff={handoff} handoffState={handoffState} handoffError={handoffError} onClose={() => setSelected(null)} onDecide={decide} onRetry={retry} />
    </section>
  </>;
}

function WorkflowStudio({ data, refresh, initialProjectId, initialWorkflowId, setSelected, selected, decide, approveMany, retry, delivery, deliveryState, deliveryError, handoff, handoffState, handoffError, onNewProject }) {
  const groups = useMemo(() => groupWorkflowReleases(data?.workflows ?? []), [data?.workflows]);
  const deepLinkApplied = useRef(false);
  const [workflowId, setWorkflowId] = useState(initialWorkflowId ?? "");
  const [projectId, setProjectId] = useState(initialProjectId ?? "all");
  const [mobileStageId, setMobileStageId] = useState("");
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [bulkApproval, setBulkApproval] = useState(null);
  const [bulkEvidence, setBulkEvidence] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState("");
  const [libraryCollapsed, setLibraryCollapsed] = useState(() => typeof window !== "undefined" && window.localStorage.getItem("nightshift.workflowLibraryCollapsed") === "true");
  const [editor, setEditor] = useState(null);
  useEffect(() => {
    if (!groups.length) return;
    if (!deepLinkApplied.current && initialProjectId) {
      const project = (data?.instances ?? []).find((entry) => entry.id === initialProjectId);
      const release = (data?.workflows ?? []).find((entry) => entry.workflowSha256 === project?.workflowSha256);
      if (release) setWorkflowId(release.workflowId);
      deepLinkApplied.current = true;
      return;
    }
    if (!groups.some((group) => group.id === workflowId)) setWorkflowId(groups[0].id);
  }, [data?.instances, data?.workflows, groups, initialProjectId, workflowId]);
  const group = groups.find((entry) => entry.id === workflowId) ?? groups[0];
  const releaseShas = useMemo(() => new Set(group?.releases.map((release) => release.workflowSha256) ?? []), [group]);
  const projects = useMemo(() => (data?.instances ?? []).filter((instance) => releaseShas.has(instance.workflowSha256)), [data?.instances, releaseShas]);
  useEffect(() => {
    if (!data) return;
    if (projectId === "all" || projects.some((project) => project.id === projectId)) return;
    const project = (data?.instances ?? []).find((entry) => entry.id === projectId);
    const release = (data?.workflows ?? []).find((entry) => entry.workflowSha256 === project?.workflowSha256);
    if (release && release.workflowId !== workflowId) return;
    setProjectId("all");
  }, [data?.instances, data?.workflows, projectId, projects, workflowId]);
  useEffect(() => {
    if (!data) return;
    updateDashboardLocation({ project: projectId === "all" ? null : projectId, workflow: workflowId || null });
  }, [data, projectId, workflowId]);
  useEffect(() => {
    window.localStorage.setItem("nightshift.workflowLibraryCollapsed", String(libraryCollapsed));
  }, [libraryCollapsed]);
  const visibleProjects = projectId === "all" ? projects : projects.filter((project) => project.id === projectId);
  const pinnedRelease = projectId === "all" ? group?.releases[0] : group?.releases.find((release) => release.workflowSha256 === visibleProjects[0]?.workflowSha256);
  const stages = pinnedRelease?.manifest?.spec?.stages ?? [];
  const taskIndex = useMemo(() => indexStageTasks(stages, visibleProjects, data?.cards ?? []), [stages, visibleProjects, data?.cards]);
  const allTasks = useMemo(() => [...taskIndex.values()].flat(), [taskIndex]);
  const liveSummary = useMemo(() => summarizeStatuses(allTasks), [allTasks]);
  const activeTasks = useMemo(() => allTasks.filter((task) => task.status === "running"), [allTasks]);
  useEffect(() => {
    if (!stages.length) return;
    if (stages.some((stage) => stage.id === mobileStageId)) return;
    const attentionStage = stages.find((stage) => (taskIndex.get(stage.id) ?? []).some((task) => ["running", "review", "blocked"].includes(task.status)));
    setMobileStageId(attentionStage?.id ?? stages[0].id);
  }, [mobileStageId, stages, taskIndex]);

  if (!data) return <div className="workflow-loading"><span className="delivery-skeleton" /><strong>正在载入 Workflow 运行状态</strong></div>;
  if (!group) return <div className="simple-screen"><header className="topbar"><div><h1>Workflows</h1><p className="topbar-copy">导入第一份 workflow.md，建立可执行生产线。</p></div><div className="top-actions"><button className="primary" onClick={() => setEditor({ mode: "create", source: newWorkflowSource() })}><Plus size={15} />新建 Workflow</button></div></header></div>;

  return <div className="workflow-screen workflow-studio">
    <header className="topbar workflow-topbar">
      <div className="workflow-title"><span className="workflow-v-avatar"><img src="/v-avatar.jpg" alt="V" /><i /></span><div className="workflow-title-copy"><span className="section-label">V · Workflow control room</span><h1>{group.name}</h1><p className={`topbar-copy workflow-live-line ${activeTasks.length ? "is-live" : ""}`}><span />{activeTasks.length ? `${activeTasks.length} 个任务运行中` : "本轮调度完成"} · {liveSummary.review ?? 0} 个待审核 · {visibleProjects.length} 个项目</p></div></div>
      <div className="workflow-header-stats" aria-label="Workflow 状态"><span><strong>{liveSummary.running ?? 0}</strong>进行中</span><span><strong>{liveSummary.review ?? 0}</strong>待审核</span><span><strong>{liveSummary.done ?? 0}</strong>已完成</span></div>
      <div className="top-actions desktop-workflow-actions"><button onClick={() => setEditor({ mode: "import", source: "" })}><Upload size={15} />导入 Workflow</button><button onClick={() => setEditor({ mode: "edit", source: group.releases[0].sourceMarkdown ?? group.releases[0].sourceYaml })}><FilePenLine size={15} />编辑 Workflow</button><button className="primary" onClick={() => setEditor({ mode: "create", source: newWorkflowSource() })}><Plus size={15} />新建 Workflow</button></div>
      <button className="mobile-workflow-menu-button" aria-label="Workflow 操作" aria-expanded={mobileActionsOpen} onClick={() => setMobileActionsOpen((value) => !value)}><MoreHorizontal size={19} /></button>
      {mobileActionsOpen && <div className="mobile-workflow-menu">
        <button onClick={() => { setMobileActionsOpen(false); setEditor({ mode: "import", source: "" }); }}><Upload size={15} />导入 Workflow</button>
        <button onClick={() => { setMobileActionsOpen(false); setEditor({ mode: "edit", source: group.releases[0].sourceMarkdown ?? group.releases[0].sourceYaml }); }}><FilePenLine size={15} />编辑 Workflow</button>
        <button onClick={() => { setMobileActionsOpen(false); setEditor({ mode: "create", source: newWorkflowSource() }); }}><Plus size={15} />新建 Workflow</button>
      </div>}
    </header>
    {projectId !== "all" && visibleProjects.map((instance) => <ExecutionControls key={instance.id} instance={instance} cards={data.cards ?? []} refresh={refresh} />)}
    <div className={`workflow-workspace ${libraryCollapsed ? "library-collapsed" : ""} ${selected ? "with-drawer" : ""}`}>
      <aside className="workflow-library" aria-label="Workflow 列表" aria-hidden={libraryCollapsed} inert={libraryCollapsed ? true : undefined}>
        <div className="library-head"><strong>Workflows</strong><span>{groups.length}</span><button aria-label="收起 Workflow 列表" title="收起 Workflow 列表" onClick={() => setLibraryCollapsed(true)}><Icons.PanelLeftClose size={15} /></button></div>
        {groups.map((entry) => {
          const shas = new Set(entry.releases.map((release) => release.workflowSha256));
          const count = (data?.instances ?? []).filter((instance) => shas.has(instance.workflowSha256)).length;
          return <button className={entry.id === group.id ? "selected" : ""} title={entry.name} key={entry.id} onClick={() => { setWorkflowId(entry.id); setProjectId("all"); }}><span className="workflow-signal" /><div><strong>{entry.name}</strong><small>{count} 个项目 · {entry.releases[0].version}</small></div></button>;
        })}
      </aside>
      {libraryCollapsed && <button className="workflow-library-peek" aria-label="展开 Workflow 列表" title="展开 Workflow 列表" onClick={() => setLibraryCollapsed(false)}><Icons.PanelLeftOpen size={16} /></button>}
      <main className="workflow-runway">
        <div className="runway-toolbar">
          <div className="release-identity"><span className="mono">{pinnedRelease?.version}</span><strong>{stages.length} 个阶段</strong><small>SHA {pinnedRelease?.workflowSha256.slice(0, 12)}</small></div>
          <div className="runway-actions">
            <label className="mobile-workflow-filter"><span>Workflow</span><select value={workflowId} onChange={(event) => { setWorkflowId(event.target.value); setProjectId("all"); }}>{groups.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} · {entry.releases[0].version}</option>)}</select><ChevronDown size={14} /></label>
            <label className="project-filter"><span>查看项目</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="all">全部项目（{projects.length}）</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown size={14} /></label>
            <button className="workflow-project-shortcut" onClick={() => onNewProject(group.releases[0])}><Plus size={13} />用最新版本新建项目</button>
          </div>
        </div>
        <nav className="mobile-stage-nav" aria-label="Workflow 阶段">
          {stages.map((stage, index) => {
            const tasks = taskIndex.get(stage.id) ?? [];
            const summary = summarizeStatuses(tasks);
            const tone = ["running", "review", "blocked", "ready", "done"].find((status) => summary[status]) ?? "empty";
            return <button className={`${mobileStageId === stage.id ? "selected" : ""} state-${tone}`} key={stage.id} onClick={() => setMobileStageId(stage.id)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{stage.title}</strong><small>{tasks.length ? `${tasks.length} 个任务` : "未开始"}</small></button>;
          })}
        </nav>
        <div className="stage-runway" style={{ "--stage-count": stages.length }}>
          <div className="stage-rail" />
          {stages.map((stage, index) => <StageLane key={stage.id} stage={stage} index={index} mobileSelected={mobileStageId === stage.id} tasks={taskIndex.get(stage.id) ?? []} onSelect={setSelected} onBulkApprove={(cards) => { setBulkApproval({ cards, stage }); setBulkEvidence(""); setBulkError(""); }} />)}
        </div>
      </main>
      <Drawer card={selected} delivery={delivery} deliveryState={deliveryState} deliveryError={deliveryError} handoff={handoff} handoffState={handoffState} handoffError={handoffError} onClose={() => setSelected(null)} onDecide={decide} onRetry={retry} />
    </div>
    {editor && <WorkflowEditor initialSource={editor.source} mode={editor.mode} onClose={() => setEditor(null)} onPublished={async () => { setEditor(null); await refresh(true); }} />}
    {bulkApproval && <div className="workflow-modal bulk-approval-modal" role="dialog" aria-modal="true" aria-label="批量审核">
      <div className="bulk-approval-dialog"><span className="section-label">Batch review</span><h2>批量通过 {bulkApproval.cards.length} 条任务</h2><p>每条任务仍会生成独立审批记录。付费生产、外部发布等动作继续严格使用各自 Workflow 声明的权限与范围。</p><textarea aria-label="批量审核备注" value={bulkEvidence} onChange={(event) => setBulkEvidence(event.target.value)} placeholder="审核备注（可选）" />{bulkError && <p className="decision-error">{bulkError}</p>}<div><button onClick={() => setBulkApproval(null)} disabled={bulkSaving}>取消</button><button className="primary" disabled={bulkSaving} onClick={async () => { setBulkSaving(true); setBulkError(""); try { await approveMany(bulkApproval.cards, bulkEvidence); setBulkApproval(null); } catch (reason) { setBulkError(reason.message); } finally { setBulkSaving(false); } }}>{bulkSaving ? "处理中…" : "确认批量通过"}</button></div></div>
    </div>}
  </div>;
}

function StageLane({ stage, index, mobileSelected, tasks, onSelect, onBulkApprove }) {
  const summary = summarizeStatuses(tasks);
  const isLive = (summary.running ?? 0) > 0;
  const reviewCards = tasks.filter((task) => task.status === "review" && task.card).map((task) => task.card);
  return <section className={`stage-lane ${isLive ? "is-live" : ""} ${mobileSelected ? "mobile-selected" : ""}`}>
    <header><span className="stage-index">{String(index + 1).padStart(2, "0")}</span><div><strong>{stage.title}</strong><small>{stage.scope === "content-item" ? "每条内容" : "整个项目"} · {stage.actor === "human" ? "人工" : "Agent"}</small></div></header>
    <div className="stage-counts">{Object.entries(summary).map(([status, count]) => <span className={`state-${status}`} key={status}>{statusLabel(status)} {count}</span>)}{tasks.length === 0 && <span>尚未开始</span>}{reviewCards.length > 1 && <button className="bulk-review-button" onClick={() => onBulkApprove(reviewCards)}>批量通过 {reviewCards.length}</button>}</div>
    <div className="stage-tasks">{tasks.map((task) => <button key={`${task.projectId}-${task.contentItemId ?? "project"}-${task.stageId}-${task.card?.id ?? task.attempt}`} className={`stage-task state-${task.status}`} disabled={!task.card} onClick={() => task.card && onSelect(task.card)}><span className="task-state" /><div><strong>{task.contentTitle ?? task.projectName}</strong><small>{task.contentTitle ? task.projectName : task.projectId}</small></div><span className="task-action">{taskActionLabel(task)}</span></button>)}</div>
  </section>;
}

function WorkflowEditor({ initialSource, mode, onClose, onPublished }) {
  const fileRef = useRef(null);
  const [workflow, setWorkflow] = useState(() => parseWorkflowAuthoringSource(initialSource) ?? emptyWorkflow());
  const [issues, setIssues] = useState([]);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const source = useMemo(() => serializeWorkflow(workflow), [workflow]);
  const updateMetadata = (patch) => setWorkflow((current) => ({ ...current, metadata: { ...current.metadata, ...patch } }));
  const updateStage = (index, patch) => setWorkflow((current) => ({ ...current, spec: { ...current.spec, stages: current.spec.stages.map((stage, stageIndex) => stageIndex === index ? { ...stage, ...patch } : stage) } }));
  const moveStage = (index, direction) => setWorkflow((current) => {
    const stages = [...current.spec.stages];
    const target = index + direction;
    if (target < 0 || target >= stages.length) return current;
    [stages[index], stages[target]] = [stages[target], stages[index]];
    return { ...current, spec: { ...current.spec, stages } };
  });
  const removeStage = (index) => setWorkflow((current) => ({ ...current, spec: { ...current.spec, stages: current.spec.stages.filter((_, stageIndex) => stageIndex !== index) } }));
  const addStage = () => setWorkflow((current) => ({ ...current, spec: { ...current.spec, stages: [...current.spec.stages, defaultStage(current.spec.stages.length + 1)] } }));

  async function loadFile(file) {
    if (!file) return;
    const text = await file.text();
    const parsed = parseWorkflowAuthoringSource(text);
    if (!parsed) { setMessage("无法读取该文件，请确认它是有效的 workflow.md"); return; }
    setWorkflow(parsed); setMessage(`已载入 ${file.name}`); setIssues([]);
  }
  async function validate() {
    try { const result = await api("/api/workflows/validate", { method: "POST", body: JSON.stringify({ sourceMarkdown: source }) }); setIssues(result.issues ?? []); setMessage(result.ok ? "检查通过，可以发布" : "请先修正标出的问题"); return result.ok; }
    catch (reason) { setMessage(reason.message); return false; }
  }
  async function persist(publish) {
    if (saving) return;
    setSaving(true);
    try {
      const result = await api("/api/workflows/import", { method: "POST", body: JSON.stringify({ sourceMarkdown: source, publish }) });
      setIssues(result.draft?.issues ?? []);
      setMessage(publish ? `已发布 ${result.release.version}` : "草稿已保存");
      if (publish) await onPublished();
    } catch (reason) { setMessage(reason.message); setSaving(false); }
  }

  return <div className="workflow-modal" role="dialog" aria-modal="true" aria-label="Workflow 编辑器">
    <div className="workflow-editor">
      <header><div><span>{mode === "edit" ? "编辑现有流程" : mode === "import" ? "导入流程" : "创建流程"}</span><h2>{workflow.metadata?.name || "新 Workflow"}</h2></div><button aria-label="关闭 Workflow 编辑器" onClick={onClose}><X size={18} /></button></header>
      <div className="editor-actions"><input ref={fileRef} type="file" accept=".md,.markdown,text/markdown,text/plain" hidden onChange={(event) => loadFile(event.target.files?.[0])} /><button onClick={() => fileRef.current?.click()}><FileUp size={15} />选择 workflow.md</button><button onClick={validate}>检查流程</button><button onClick={() => persist(false)} disabled={saving}><Save size={15} />保存草稿</button><button className="primary" onClick={() => persist(true)} disabled={saving}>{saving ? "处理中…" : "发布新版本"}</button></div>
      <div className="editor-body">
        <section className="workflow-form">
          <div className="form-grid"><label><span>名称</span><input value={workflow.metadata?.name ?? ""} onChange={(event) => updateMetadata({ name: event.target.value })} /></label><label><span>Workflow ID</span><input className="mono" value={workflow.metadata?.id ?? ""} onChange={(event) => updateMetadata({ id: slug(event.target.value) })} /></label><label><span>版本</span><input className="mono" value={workflow.metadata?.version ?? ""} onChange={(event) => updateMetadata({ version: event.target.value })} /></label></div>
          <div className="visual-stage-editor">{(workflow.spec?.stages ?? []).map((stage, index) => <article key={`${stage.id}-${index}`} className="editable-stage">
            <div className="editable-stage-head"><span>{String(index + 1).padStart(2, "0")}</span><input value={stage.title ?? ""} aria-label={`阶段 ${index + 1} 名称`} onChange={(event) => updateStage(index, { title: event.target.value })} /><div><button aria-label="上移阶段" onClick={() => moveStage(index, -1)} disabled={index === 0}><ArrowUp size={14} /></button><button aria-label="下移阶段" onClick={() => moveStage(index, 1)} disabled={index === workflow.spec.stages.length - 1}><ArrowDown size={14} /></button><button aria-label="删除阶段" onClick={() => removeStage(index)}><X size={14} /></button></div></div>
            <div className="editable-stage-fields"><label><span>ID</span><input className="mono" value={stage.id ?? ""} onChange={(event) => updateStage(index, { id: slug(event.target.value) })} /></label><label><span>执行者</span><select value={stage.actor ?? "agent"} onChange={(event) => updateStage(index, { actor: event.target.value })}><option value="agent">Agent</option><option value="human">人工</option></select></label><label><span>范围</span><select value={stage.scope ?? "project"} onChange={(event) => updateStage(index, { scope: event.target.value })}><option value="project">整个项目</option><option value="content-item">每条内容</option></select></label><label><span>依赖阶段</span><input value={(stage.needs ?? []).join(", ")} onChange={(event) => updateStage(index, { needs: csv(event.target.value) })} placeholder="plan, route" /></label><label className="wide"><span>Agent Skills</span><input value={(stage.skills ?? []).join(", ")} onChange={(event) => updateStage(index, { skills: csv(event.target.value) })} /></label><label className="wide"><span>阶段说明</span><textarea value={stage.description ?? ""} onChange={(event) => updateStage(index, { description: event.target.value })} /></label></div>
          </article>)}</div>
          <button className="add-stage" onClick={addStage}><Plus size={15} />增加一个阶段</button>
        </section>
        <aside className="editor-preview"><strong>运行预览</strong><p>发布后，所有新项目都会沿这条轨道运行。</p><ol>{(workflow.spec?.stages ?? []).map((stage, index) => <li key={`${stage.id}-preview`}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{stage.title || "未命名阶段"}</strong><small>{stage.actor === "human" ? "人工" : "Agent"} · {stage.scope === "content-item" ? "每条内容" : "整个项目"}</small></div></li>)}</ol><button className="advanced-toggle" onClick={() => setAdvanced((value) => !value)}>{advanced ? "隐藏高级源文件" : "查看高级源文件"}</button>{advanced && <textarea aria-label="Workflow Markdown 高级编辑" value={source} onChange={(event) => { const parsed = parseWorkflowAuthoringSource(event.target.value); if (parsed) setWorkflow(parsed); }} />}{issues.length > 0 && <div className="issues"><strong>需要修正</strong>{issues.map((issue) => <p key={`${issue.path}-${issue.code}`}>{issue.path}: {issue.message}</p>)}</div>}{message && <div className="toast-inline">{message}</div>}</aside>
      </div>
    </div>
  </div>;
}

function ProjectEditor({ releases, initialReleaseSha, onClose, onCreated }) {
  const initialRelease = releases.find((release) => release.workflowSha256 === initialReleaseSha) ?? releases[0];
  const [releaseSha, setReleaseSha] = useState(initialRelease?.workflowSha256 ?? "");
  const [form, setForm] = useState(() => newProjectForm(initialRelease));
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const release = releases.find((entry) => entry.workflowSha256 === releaseSha) ?? initialRelease;
  const contracts = release?.manifest?.spec?.inputs ?? {};
  const roles = workflowAgentRoles(release);

  function chooseRelease(nextSha) {
    const nextRelease = releases.find((entry) => entry.workflowSha256 === nextSha);
    setReleaseSha(nextSha);
    setForm((current) => ({ ...current, agentBindings: defaultAgentBindings(nextRelease), inputs: defaultProjectInputs(nextRelease) }));
    setMessage("");
  }

  function updateInput(name, value) {
    setForm((current) => ({ ...current, inputs: { ...current.inputs, [name]: value } }));
  }

  async function createProject(event) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setMessage("");
    try {
      const result = await api("/api/instances", {
        method: "POST",
        body: JSON.stringify({
          id: form.id.trim(),
          name: form.name.trim(),
          workflowSha256: release.workflowSha256,
          inputs: form.inputs,
          agentBindings: form.agentBindings,
          status: "active",
          dispatch: true,
        }),
      });
      onCreated(result);
    } catch (reason) {
      setMessage(reason.message);
      setSubmitting(false);
    }
  }

  if (!release) return null;
  return <div className="workflow-modal" role="dialog" aria-modal="true" aria-label="新建项目">
    <form className="project-editor" onSubmit={createProject}>
      <header><div><span>New project</span><h2>把客户工作放上生产线</h2><p>项目会锁定所选 Workflow 版本；创建后立即进入第一个阶段。</p></div><button type="button" aria-label="关闭新建项目" onClick={onClose}><X size={18} /></button></header>
      <div className="project-form-body">
        <section className="project-form-main">
          <label className="project-field"><span>Workflow 版本</span><select value={releaseSha} onChange={(event) => chooseRelease(event.target.value)}>{releases.map((entry) => <option key={entry.workflowSha256} value={entry.workflowSha256}>{entry.name} · {entry.version}</option>)}</select><small>项目开始后会固定在 SHA {release.workflowSha256.slice(0, 12)}</small></label>
          <div className="project-form-grid"><label className="project-field"><span>项目名称</span><input autoFocus value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} placeholder="例如：振丰｜8 月内容生产" required /></label><label className="project-field"><span>Project ID</span><input className="mono" maxLength={31} value={form.id} onChange={(event) => setForm((current) => ({ ...current, id: event.target.value }))} required /><small>最多 31 个英文、数字、点、下划线或连字符</small></label></div>
          <div className="project-section-head"><strong>Workflow 输入</strong><span>由 workflow.md 自动生成</span></div>
          <div className="project-inputs">{Object.entries(contracts).map(([name, contract]) => <ProjectInput key={name} name={name} contract={contract} value={form.inputs[name]} onChange={(value) => updateInput(name, value)} />)}</div>
          <div className="project-section-head"><strong>Agent 绑定</strong><span>逻辑角色映射到 OpenClaw Agent</span></div>
          <div className="project-form-grid">{roles.map((role) => <label className="project-field" key={role}><span>{role}</span><input value={form.agentBindings[role] ?? ""} onChange={(event) => setForm((current) => ({ ...current, agentBindings: { ...current.agentBindings, [role]: event.target.value } }))} placeholder="main" required /></label>)}</div>
        </section>
        <aside className="project-safety">
          <strong>创建后会发生什么</strong>
          <ol><li><span>01</span><p>锁定 <b>{release.name} {release.version}</b></p></li><li><span>02</span><p>项目进入 <b>Active</b></p></li><li><span>03</span><p>立即创建并派发 <b>{release.manifest.spec.stages?.[0]?.title ?? "第一阶段"}</b></p></li><li><span>04</span><p>后续阶段按照依赖自动推进</p></li></ol>
          <div className="safety-note"><Icons.ShieldCheck size={16} /><div><strong>安全默认值</strong><p>付费生产和外部发布默认关闭，必须在对应阶段再次人工批准。</p></div></div>
        </aside>
      </div>
      <footer>{message && <p className="project-message">{message}</p>}<button type="button" onClick={onClose}>取消</button><button className="primary" type="submit" disabled={submitting}>{submitting ? "正在创建…" : "创建并启动项目"}</button></footer>
    </form>
  </div>;
}

function ProjectInput({ name, contract, value, onChange }) {
  const labelText = projectInputLabel(name);
  if (name === "authorizationScope") {
    const scope = value ?? {};
    return <fieldset className="authorization-field"><legend>{labelText}</legend><label><input type="checkbox" checked={scope.paidProduction === true} onChange={(event) => onChange({ ...scope, paidProduction: event.target.checked })} /><span>允许进入付费生产审批</span></label><label><input type="checkbox" checked={scope.externalPublication === true} onChange={(event) => onChange({ ...scope, externalPublication: event.target.checked })} /><span>允许申请外部发布</span></label><label><input type="checkbox" checked={scope.vlabOnly !== false} onChange={(event) => onChange({ ...scope, vlabOnly: event.target.checked })} /><span>仅由 V 内部执行</span></label></fieldset>;
  }
  if (Array.isArray(contract.enum) && contract.enum.length > 0) {
    return <label className="project-field"><span>{labelText}{contract.required ? " *" : ""}</span><select value={value ?? contract.enum[0]} onChange={(event) => onChange(event.target.value)}>{contract.enum.map((option) => <option key={String(option)} value={option}>{option === "publish" ? "发布到账号" : option === "download" ? "下载包交付" : String(option)}</option>)}</select></label>;
  }
  if (contract.type === "boolean") return <label className="project-field checkbox-field"><input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} /><span>{labelText}</span></label>;
  if (contract.type === "object" || contract.type === "array") return <label className="project-field wide"><span>{labelText}{contract.required ? " *" : ""}</span><textarea value={typeof value === "string" ? value : JSON.stringify(value ?? (contract.type === "array" ? [] : {}), null, 2)} onChange={(event) => onChange(parseJsonValue(event.target.value))} /></label>;
  return <label className="project-field"><span>{labelText}{contract.required ? " *" : ""}</span><input type={contract.type === "number" ? "number" : name.toLowerCase().includes("url") ? "url" : "text"} value={value ?? ""} onChange={(event) => onChange(contract.type === "number" ? Number(event.target.value) : event.target.value)} required={contract.required === true} placeholder={projectInputPlaceholder(name)} /></label>;
}

function Projects({ data, onNewProject, onOpenProject, refresh }) {
  const [deleting, setDeleting] = useState(null);
  const [deleteError, setDeleteError] = useState("");
  async function archiveProject(instance) {
    setDeleteError("");
    try {
      await api(`/api/instances/${encodeURIComponent(instance.id)}/archive`, { method: "POST", body: JSON.stringify({ reason: "Archived from Live Board" }) });
      setDeleting(null);
      await refresh(true);
    } catch (reason) { setDeleteError(reason.message); }
  }
  return <div className="simple-screen projects-screen"><header className="topbar"><div><span className="section-label">V · Workflow instances</span><h1>Projects</h1><p className="topbar-copy">每个项目是一条由 V 驱动、锁定 Workflow 版本的生产线。</p></div><div className="top-actions"><button className="primary" onClick={onNewProject}><Plus size={15} />新建项目</button></div></header><div className="project-table"><div className="table-head"><span>Project</span><span>Workflow</span><span>视频任务</span><span>Status</span><span>Updated</span><span /></div>{(data?.instances ?? []).map((instance) => <div className="table-row" role="button" tabIndex="0" onClick={() => onOpenProject(instance.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onOpenProject(instance.id); }} key={instance.id}><strong className="project-name">{instance.name}</strong><span className="project-workflow mono">{instance.workflowSha256.slice(0, 12)}</span><span className="project-content">{instance.contentItems?.length ?? 0} 条 · {routeSummary(instance.contentItems)}</span><span className={`project-status status-${instance.status}`}>{instance.control?.fault ? "调度失败" : instance.status}</span><span className="project-updated">{new Date(instance.updatedAt).toLocaleString()}</span><button className="project-delete" aria-label={`归档项目 ${instance.name}`} title="归档项目" onClick={(event) => { event.stopPropagation(); setDeleteError(""); setDeleting(instance); }}><Trash2 size={15} /></button></div>)}</div>{deleting && <div className="confirm-scrim" role="dialog" aria-modal="true" aria-label="归档项目"><div className="confirm-dialog"><span className="confirm-icon"><Trash2 size={20} /></span><h2>归档这个项目？</h2><p><strong>{deleting.name}</strong> 将从默认视野中隐藏，卡片、Session、评论和产物保持原样，可随时恢复。运行中的项目不会被归档。</p>{deleteError && <div className="confirm-error">{deleteError}</div>}<div><button onClick={() => setDeleting(null)}>取消</button><button className="danger" onClick={() => archiveProject(deleting)}>归档项目</button></div></div></div>}</div>;
}

function Agents({ data }) {
  const agents = [...new Set([
    ...(data?.cards ?? []).map((card) => card.agentId),
    ...(data?.instances ?? []).flatMap((instance) => Object.values(instance.agentBindings ?? {})),
  ].filter(Boolean))];
  return <div className="simple-screen agents-screen"><header className="topbar"><div><span className="section-label">OpenClaw workers</span><h1>Agents</h1><p className="topbar-copy">当前参与 Workflow 与原生 Workboard 的 Agent。</p></div></header><div className="agent-list">{agents.length ? agents.map((agent) => <div className="agent-row" key={agent}><span className="agent-avatar"><Icons.Bot size={18} /></span><div><strong>{agent}</strong><span>Workflow binding or native Workboard assignment</span></div><span className="live-dot" /></div>) : <p className="empty-copy">No agent binding has been declared.</p>}</div></div>;
}

function label(card, prefix) { return card.labels?.find((entry) => entry.startsWith(`${prefix}:`))?.slice(prefix.length + 1); }

function cardLabel(card, prefix) {
  return card.metadata?.automation?.[`${prefix}Id`] ?? label(card, prefix);
}

function parseWorkflowAuthoringSource(source) {
  try {
    if (!source.trimStart().startsWith("---")) return YAML.parse(source);
    const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(source);
    if (!frontmatter) return null;
    const document = YAML.parse(frontmatter[1]);
    const headings = [...source.matchAll(/^##\s+(?:STAGE|STEP)\s+([a-z][a-z0-9-]*)\s*(?:｜|\||:|—|-)\s*(.+?)\s*$/gm)];
    const stages = headings.map((match, index) => {
      const section = source.slice(match.index + match[0].length, headings[index + 1]?.index ?? source.length);
      const block = /```stage\s*\r?\n([\s\S]*?)\r?\n```/.exec(section);
      const stage = block ? YAML.parse(block[1]) : {};
      return { ...stage, id: match[1], title: match[2] };
    });
    return { ...document, spec: { ...(document.spec ?? {}), stages } };
  } catch {
    return null;
  }
}

function serializeWorkflow(workflow) {
  const stages = workflow.spec?.stages ?? [];
  const frontmatter = { ...workflow, spec: { ...(workflow.spec ?? {}) } };
  delete frontmatter.spec.stages;
  const sections = stages.map((stage) => {
    const body = { ...stage };
    delete body.id;
    delete body.title;
    delete body.order;
    return `## STAGE ${stage.id}｜${stage.title}\n\n\`\`\`stage\n${YAML.stringify(body).trim()}\n\`\`\``;
  });
  return `---\n${YAML.stringify(frontmatter).trim()}\n---\n\n${sections.join("\n\n")}`;
}

function emptyWorkflow() {
  return {
    apiVersion: "nightshift.versa.ai/v1alpha1",
    kind: "Workflow",
    metadata: { id: "new-workflow", version: "0.1.0-draft", name: "新 Workflow" },
    spec: {
      ownerAgentRole: "operator",
      concurrency: { perInstance: 2, maxActiveInstances: 3 },
      completion: { mode: "strict-v1" },
      inputs: {},
      stages: [defaultStage(1)],
    },
  };
}

function newWorkflowSource() { return serializeWorkflow(emptyWorkflow()); }

function newProjectForm(release) {
  return {
    id: newProjectId(),
    name: "",
    inputs: defaultProjectInputs(release),
    agentBindings: defaultAgentBindings(release),
  };
}

function newProjectId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `NS-LAB-${stamp}`;
}

function defaultProjectInputs(release) {
  const result = {};
  for (const [name, contract] of Object.entries(release?.manifest?.spec?.inputs ?? {})) {
    if (name === "authorizationScope") result[name] = { paidProduction: false, externalPublication: false, vlabOnly: true };
    else if (Array.isArray(contract.enum) && contract.enum.length > 0) result[name] = contract.enum[0];
    else if (contract.type === "object") result[name] = {};
    else if (contract.type === "array") result[name] = [];
    else if (contract.type === "boolean") result[name] = false;
    else if (contract.type === "number") result[name] = 0;
    else result[name] = "";
  }
  return result;
}

function workflowAgentRoles(release) {
  return [...new Set((release?.manifest?.spec?.stages ?? []).filter((stage) => stage.actor === "agent").map((stage) => stage.agentRole ?? release.manifest.spec.ownerAgentRole))];
}

function defaultAgentBindings(release) {
  return Object.fromEntries(workflowAgentRoles(release).map((role) => [role, "main"]));
}

function projectInputLabel(name) {
  return ({ customerId: "客户 ID", briefUrl: "策划案 URL", authorizationScope: "执行权限", deliveryMode: "交付模式" })[name] ?? name;
}

function projectInputPlaceholder(name) {
  return ({ customerId: "客户或合同中的稳定 ID", briefUrl: "https://..." })[name] ?? "";
}

function parseJsonValue(value) {
  try { return JSON.parse(value); }
  catch { return value; }
}

function readDashboardLocation() {
  if (typeof window === "undefined") return { card: null, project: null, view: "board", workflow: null };
  const parameters = new URLSearchParams(window.location.search);
  const view = ["board", "workflows", "projects", "agents"].includes(parameters.get("view")) ? parameters.get("view") : "board";
  return {
    card: parameters.get("card"),
    project: parameters.get("project"),
    view,
    workflow: parameters.get("workflow"),
  };
}

function updateDashboardLocation(patch) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(patch)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  window.history.replaceState(null, "", url);
}

function defaultStage(number) {
  return {
    id: `stage-${number}`,
    title: `阶段 ${number}`,
    actor: "agent",
    scope: "project",
    skills: [],
    needs: number === 1 ? [] : [`stage-${number - 1}`],
    outputs: ["completed"],
    completeWhen: ["output.completed"],
    timeout: "30m",
    retry: { maxAttempts: 2, idempotencyKey: `\${instance.id}:stage-${number}:\${input.hash}` },
  };
}

function groupWorkflowReleases(releases) {
  const groups = new Map();
  for (const release of releases) {
    const current = groups.get(release.workflowId) ?? { id: release.workflowId, name: release.name, releases: [] };
    current.releases.push(release);
    groups.set(release.workflowId, current);
  }
  return [...groups.values()];
}

function indexStageTasks(stages, projects, cards) {
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const result = new Map(stages.map((stage) => [stage.id, []]));
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  for (const project of projects) {
    const contentById = new Map((project.contentItems ?? []).map((item) => [item.id, item]));
    const runs = [
      ...(project.stageRuns ?? []).map((run) => ({ ...run, contentItemId: null })),
      ...(project.contentItemRuns ?? []),
    ];
    for (const run of runs) {
      if (!result.has(run.stageId)) continue;
      const card = cardById.get(run.cardId);
      const content = run.contentItemId ? contentById.get(run.contentItemId) : null;
      result.get(run.stageId).push({
        ...run,
        card,
        contentTitle: content?.title,
        guardedEffect: stageById.get(run.stageId)?.approval?.before ?? null,
        projectId: project.id,
        projectName: project.name,
        requiresApproval: missingApprovalFor(project, stageById.get(run.stageId), run.contentItemId),
        status: card?.status ?? run.status,
      });
    }
  }
  for (const card of cards) {
    if (!(card.labels ?? []).includes("nightshift:approval")) continue;
    const projectId = label(card, "instance");
    const stageId = label(card, "stage");
    const project = projectsById.get(projectId);
    if (!project || !result.has(stageId)) continue;
    if ([...result.get(stageId)].some((task) => task.card?.id === card.id)) continue;
    const contentItemId = label(card, "content-item");
    const content = (project.contentItems ?? []).find((item) => item.id === contentItemId);
    result.get(stageId).push({
      attempt: card.metadata?.automation?.attempt ?? 1,
      card,
      contentItemId,
      contentTitle: content?.title,
      guardedEffect: stageById.get(stageId)?.approval?.before ?? null,
      isApproval: true,
      projectId,
      projectName: project.name,
      requiresApproval: true,
      stageId,
      status: card.status,
    });
  }
  for (const [stageId, tasks] of result) {
    const latest = new Map();
    for (const task of tasks) {
      const key = `${task.projectId}:${task.contentItemId ?? "project"}`;
      const current = latest.get(key);
      if (!current || preferTask(task, current)) latest.set(key, task);
    }
    result.set(stageId, [...latest.values()].sort((left, right) => statusOrder(left.status) - statusOrder(right.status) || left.projectName.localeCompare(right.projectName)));
  }
  return result;
}

function withDecisionContext(card, data) {
  if (!card || !data) return card;
  const fresh = (data.cards ?? []).find((entry) => entry.id === card.id) ?? card;
  const instanceId = cardLabel(fresh, "instance");
  const stageId = fresh.metadata?.automation?.stageId ?? label(fresh, "stage");
  const contentItemId = fresh.metadata?.automation?.contentItemId ?? label(fresh, "content-item") ?? null;
  const instance = (data.instances ?? []).find((entry) => entry.id === instanceId);
  const release = (data.workflows ?? []).find((entry) => entry.workflowSha256 === instance?.workflowSha256);
  const stage = release?.manifest?.spec?.stages?.find((entry) => entry.id === stageId);
  const required = stage?.approval?.before
    ? { effect: stage.approval.before, scope: stage.approval.scope ?? "stage" }
    : null;
  const approvalCard = (data.cards ?? []).find((entry) => {
    if (!(entry.labels ?? []).includes("nightshift:approval")) return false;
    if (cardLabel(entry, "instance") !== instanceId || label(entry, "stage") !== stageId) return false;
    return (label(entry, "content-item") ?? null) === contentItemId && entry.status === "review";
  });
  const isApprovalCard = (fresh.labels ?? []).includes("nightshift:approval");
  const missingApproval = required && missingApprovalFor(instance, stage, contentItemId);
  const pendingExecutionApproval = fresh.status === "blocked" && !isApprovalCard && missingApproval && approvalCard;
  if (!isApprovalCard && !pendingExecutionApproval) return fresh;
  const decisionCard = isApprovalCard ? fresh : approvalCard;
  return {
    ...fresh,
    metadata: {
      ...(fresh.metadata ?? {}),
      automation: {
        ...(fresh.metadata?.automation ?? {}),
        approval: required,
        contentItemId,
        decisionCardId: decisionCard.id,
        instanceId,
        pendingExecutionApproval: Boolean(pendingExecutionApproval),
        stageId,
        workflowSha256: release?.workflowSha256,
      },
    },
  };
}

function missingApprovalFor(instance, stage, contentItemId = null) {
  if (!stage?.approval?.before) return false;
  const requiredScope = stage.approval.scope ?? "stage";
  return !(instance?.approvals ?? []).some((approval) =>
    approval.status === "approved" &&
    approval.stageId === stage.id &&
    (approval.contentItemId ?? null) === (contentItemId ?? null) &&
    approval.effect === stage.approval.before &&
    approval.scope === requiredScope &&
    (!approval.expiresAt || new Date(approval.expiresAt) > new Date())
  );
}

function summarizeStatuses(tasks) {
  return tasks.reduce((summary, task) => ({ ...summary, [task.status]: (summary[task.status] ?? 0) + 1 }), {});
}

function statusOrder(status) { return ({ running: 0, review: 1, blocked: 2, ready: 3, done: 4 })[status] ?? 5; }

function preferTask(candidate, current) {
  const candidateRank = statusOrder(candidate.status);
  const currentRank = statusOrder(current.status);
  if (candidateRank !== currentRank) return candidateRank < currentRank;
  return new Date(candidate.card?.updatedAt ?? candidate.updatedAt ?? 0) > new Date(current.card?.updatedAt ?? current.updatedAt ?? 0);
}

function statusLabel(status) {
  return ({ ready: "待开始", running: "进行中", review: "待审核", blocked: "已阻塞", done: "已完成", cancelled: "已取消" })[status] ?? status;
}

function taskActionLabel(task) {
  const effect = guardedEffectLabel(task.guardedEffect);
  if (task.requiresApproval && effect) return `确认${effect}`;
  if (task.status === "done" && effect) return `${effect}完成`;
  if (task.status === "blocked" && effect) return `${effect}未完成`;
  return task.requiresApproval ? "等待确认执行" : statusLabel(task.status);
}

function guardedEffectLabel(effect) {
  return ({ "external-publication": "外部发布", "paid-production": "付费生产", destructive: "高风险操作", "permission-change": "权限变更" })[effect] ?? null;
}

function csv(value) { return value.split(",").map((entry) => entry.trim()).filter(Boolean); }
function slug(value) { return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""); }

function routeSummary(items = []) {
  const counts = items.reduce((result, item) => ({ ...result, [item.route ?? "待分流"]: (result[item.route ?? "待分流"] ?? 0) + 1 }), {});
  return Object.entries(counts).map(([route, count]) => `${route} ${count}`).join(" / ") || "待拆单";
}
