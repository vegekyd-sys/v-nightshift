import React, { useEffect, useMemo, useRef, useState } from "react";
import YAML from "yaml";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  FilePenLine,
  FileUp,
  Plus,
  Save,
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
  const [active, setActive] = useState("board");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(null);
  const [delivery, setDelivery] = useState(null);
  const [deliveryState, setDeliveryState] = useState("idle");
  const [deliveryError, setDeliveryError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [projectReleaseSha, setProjectReleaseSha] = useState(null);
  const refreshInFlight = useRef(null);

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
    const instanceId = selected ? cardLabel(selected, "instance") : null;
    const contentItemId = selected?.metadata?.automation?.contentItemId ?? (selected ? label(selected, "content-item") : null);
    if (!instanceId) {
      setDelivery(null);
      setDeliveryState("idle");
      setDeliveryError("");
      return undefined;
    }
    let current = true;
    setDelivery(null);
    setDeliveryState("loading");
    setDeliveryError("");
    const deliveryPath = contentItemId
      ? `/api/instances/${encodeURIComponent(instanceId)}/content-items/${encodeURIComponent(contentItemId)}/deliverables`
      : `/api/instances/${encodeURIComponent(instanceId)}/deliverables`;
    api(deliveryPath)
      .then((result) => {
        if (!current) return;
        setDelivery(result);
        setDeliveryState("ready");
      })
      .catch((reason) => {
        if (!current) return;
        setDeliveryError(reason.message);
        setDeliveryState("missing");
      });
    return () => { current = false; };
  }, [selected?.id]);

  async function decide(card, status, evidence) {
    const instanceId = cardLabel(card, "instance");
    const contentItemId = card.metadata?.automation?.contentItemId ?? label(card, "content-item");
    const stageId = card.metadata?.automation?.stageId ?? label(card, "stage");
    const approval = card.metadata?.automation?.approval;
    try {
      await api(`/api/cards/${card.id}/${status}`, {
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
    <div className="app-shell">
      <Sidebar active={active} onChange={setActive} />
      <main className="main-shell">
        {error && <div className="error-banner">{error}</div>}
        {active === "board" && <LiveBoard data={data} query={query} setQuery={setQuery} selected={selected} setSelected={setSelected} refreshing={refreshing} refresh={refresh} decide={decide} retry={retry} delivery={delivery} deliveryState={deliveryState} deliveryError={deliveryError} />}
        {active === "workflows" && <WorkflowStudio data={data} refresh={refresh} setSelected={setSelected} selected={selected} decide={decide} retry={retry} delivery={delivery} deliveryState={deliveryState} deliveryError={deliveryError} onNewProject={(release) => setProjectReleaseSha(release?.workflowSha256 ?? data?.workflows?.[0]?.workflowSha256)} />}
        {active === "projects" && <Projects data={data} onNewProject={() => setProjectReleaseSha(data?.workflows?.[0]?.workflowSha256)} />}
        {active === "agents" && <Agents data={data} />}
      </main>
      {projectReleaseSha && <ProjectEditor releases={data?.workflows ?? []} initialReleaseSha={projectReleaseSha} onClose={() => setProjectReleaseSha(null)} onCreated={(result) => { setProjectReleaseSha(null); setActive("workflows"); if (result.initialScheduleError) setError(`项目已创建，首次调度将在下一轮重试：${result.initialScheduleError}`); refresh(true).catch((reason) => setError(reason.message)); }} />}
    </div>
  );
}

function LiveBoard({ data, query, setQuery, selected, setSelected, refreshing, refresh, decide, retry, delivery, deliveryState, deliveryError }) {
  const cards = useMemo(() => (data?.cards ?? []).filter((card) => !query || card.title.toLowerCase().includes(query.toLowerCase())), [data, query]);
  const count = (statuses) => cards.filter((card) => statuses.includes(card.status)).length;
  return <>
    <header className="topbar"><div><span className="section-label">Night Shift operations</span><h1>Live Workboard</h1></div><div className="top-actions"><label className="search"><Icons.Search size={16} /><input aria-label="Search cards" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search work" /></label><button onClick={() => refresh(true)} className="refresh-button">{refreshing ? "Refreshing…" : "Refresh"}</button></div></header>
    <section className="metrics"><Metric label="Active agents" value={count(["running"])} tone="active" /><Metric label="Waiting review" value={count(["review"])} tone="review" /><Metric label="Blocked" value={count(["blocked"])} tone="blocked" /><Metric label="Completed" value={count(["done"])} /></section>
    <section className={`board ${selected ? "with-drawer" : ""}`}>
      <div className="board-columns">{columns.map(([id, title, statuses]) => { const items = cards.filter((card) => statuses.includes(card.status)); return <div className={`board-column column-${id}`} key={id}><div className="column-head"><h2>{title}</h2><span>{items.length}</span></div><div className="column-body">{items.map((card) => <WorkCard key={card.id} card={card} onClick={setSelected} />)}{items.length === 0 && <EmptyColumn />}</div></div>; })}</div>
      <Drawer card={selected} delivery={delivery} deliveryState={deliveryState} deliveryError={deliveryError} onClose={() => setSelected(null)} onDecide={decide} onRetry={retry} />
    </section>
  </>;
}

function WorkflowStudio({ data, refresh, setSelected, selected, decide, retry, delivery, deliveryState, deliveryError, onNewProject }) {
  const groups = useMemo(() => groupWorkflowReleases(data?.workflows ?? []), [data?.workflows]);
  const [workflowId, setWorkflowId] = useState("");
  const [projectId, setProjectId] = useState("all");
  const [editor, setEditor] = useState(null);
  useEffect(() => {
    if (!groups.length) return;
    if (!groups.some((group) => group.id === workflowId)) setWorkflowId(groups[0].id);
  }, [groups, workflowId]);
  const group = groups.find((entry) => entry.id === workflowId) ?? groups[0];
  const releaseShas = useMemo(() => new Set(group?.releases.map((release) => release.workflowSha256) ?? []), [group]);
  const projects = useMemo(() => (data?.instances ?? []).filter((instance) => releaseShas.has(instance.workflowSha256)), [data?.instances, releaseShas]);
  useEffect(() => { if (projectId !== "all" && !projects.some((project) => project.id === projectId)) setProjectId("all"); }, [projectId, projects]);
  const visibleProjects = projectId === "all" ? projects : projects.filter((project) => project.id === projectId);
  const pinnedRelease = projectId === "all" ? group?.releases[0] : group?.releases.find((release) => release.workflowSha256 === visibleProjects[0]?.workflowSha256);
  const stages = pinnedRelease?.manifest?.spec?.stages ?? [];
  const taskIndex = useMemo(() => indexStageTasks(stages, visibleProjects, data?.cards ?? []), [stages, visibleProjects, data?.cards]);

  if (!data) return <div className="workflow-loading"><span className="delivery-skeleton" /><strong>正在载入 Workflow 运行状态</strong></div>;
  if (!group) return <div className="simple-screen"><header className="topbar"><div><h1>Workflows</h1><p className="topbar-copy">导入第一份 workflow.md，建立可执行生产线。</p></div><div className="top-actions"><button className="primary" onClick={() => setEditor({ mode: "create", source: newWorkflowSource() })}><Plus size={15} />新建 Workflow</button></div></header></div>;

  return <div className="workflow-screen workflow-studio">
    <header className="topbar workflow-topbar">
      <div><span className="section-label">Workflow operations</span><h1>{group.name}</h1><p className="topbar-copy">每个项目沿同一条阶段轨道运行；点击任务即可查看证据、处理审核或解除阻塞。</p></div>
      <div className="top-actions"><button className="primary" onClick={() => onNewProject(pinnedRelease ?? group.releases[0])}><Plus size={15} />新建项目</button><button onClick={() => setEditor({ mode: "import", source: "" })}><Upload size={15} />导入 Workflow</button><button onClick={() => setEditor({ mode: "edit", source: group.releases[0].sourceMarkdown ?? group.releases[0].sourceYaml })}><FilePenLine size={15} />编辑 Workflow</button><button onClick={() => setEditor({ mode: "create", source: newWorkflowSource() })}><Plus size={15} />新建 Workflow</button></div>
    </header>
    <div className={`workflow-workspace ${selected ? "with-drawer" : ""}`}>
      <aside className="workflow-library" aria-label="Workflow 列表">
        <div className="library-head"><strong>Workflows</strong><span>{groups.length}</span></div>
        {groups.map((entry) => {
          const shas = new Set(entry.releases.map((release) => release.workflowSha256));
          const count = (data?.instances ?? []).filter((instance) => shas.has(instance.workflowSha256)).length;
          return <button className={entry.id === group.id ? "selected" : ""} key={entry.id} onClick={() => { setWorkflowId(entry.id); setProjectId("all"); }}><span className="workflow-signal" /><div><strong>{entry.name}</strong><small>{count} 个项目 · {entry.releases[0].version}</small></div></button>;
        })}
      </aside>
      <main className="workflow-runway">
        <div className="runway-toolbar">
          <div className="release-identity"><span className="mono">{pinnedRelease?.version}</span><strong>{stages.length} 个阶段</strong><small>SHA {pinnedRelease?.workflowSha256.slice(0, 12)}</small></div>
          <label className="project-filter"><span>查看项目</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="all">全部项目（{projects.length}）</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><ChevronDown size={14} /></label>
        </div>
        <div className="stage-runway" style={{ "--stage-count": stages.length }}>
          <div className="stage-rail" />
          {stages.map((stage, index) => <StageLane key={stage.id} stage={stage} index={index} tasks={taskIndex.get(stage.id) ?? []} onSelect={setSelected} />)}
        </div>
      </main>
      <Drawer card={selected} delivery={delivery} deliveryState={deliveryState} deliveryError={deliveryError} onClose={() => setSelected(null)} onDecide={decide} onRetry={retry} />
    </div>
    {editor && <WorkflowEditor initialSource={editor.source} mode={editor.mode} onClose={() => setEditor(null)} onPublished={async () => { setEditor(null); await refresh(true); }} />}
  </div>;
}

function StageLane({ stage, index, tasks, onSelect }) {
  const summary = summarizeStatuses(tasks);
  return <section className="stage-lane">
    <header><span className="stage-index">{String(index + 1).padStart(2, "0")}</span><div><strong>{stage.title}</strong><small>{stage.scope === "content-item" ? "每条内容" : "整个项目"} · {stage.actor === "human" ? "人工" : "Agent"}</small></div></header>
    <div className="stage-counts">{Object.entries(summary).map(([status, count]) => <span className={`state-${status}`} key={status}>{statusLabel(status)} {count}</span>)}{tasks.length === 0 && <span>尚未开始</span>}</div>
    <div className="stage-tasks">{tasks.map((task) => <button key={`${task.projectId}-${task.contentItemId ?? "project"}-${task.stageId}-${task.card?.id ?? task.attempt}`} className={`stage-task state-${task.status}`} disabled={!task.card} onClick={() => task.card && onSelect(task.card)}><span className="task-state" /><div><strong>{task.contentTitle ?? task.projectName}</strong><small>{task.contentTitle ? task.projectName : task.projectId}</small></div><span className="task-action">{task.stageId === "publish-feedback" && (task.status === "blocked" || task.isApproval) ? "等待发布授权" : statusLabel(task.status)}</span></button>)}</div>
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
    return <fieldset className="authorization-field"><legend>{labelText}</legend><label><input type="checkbox" checked={scope.paidProduction === true} onChange={(event) => onChange({ ...scope, paidProduction: event.target.checked })} /><span>允许进入付费生产审批</span></label><label><input type="checkbox" checked={scope.externalPublication === true} onChange={(event) => onChange({ ...scope, externalPublication: event.target.checked })} /><span>允许申请外部发布</span></label><label><input type="checkbox" checked={scope.vlabOnly !== false} onChange={(event) => onChange({ ...scope, vlabOnly: event.target.checked })} /><span>仅在 VLab 运行</span></label></fieldset>;
  }
  if (contract.type === "boolean") return <label className="project-field checkbox-field"><input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} /><span>{labelText}</span></label>;
  if (contract.type === "object" || contract.type === "array") return <label className="project-field wide"><span>{labelText}{contract.required ? " *" : ""}</span><textarea value={typeof value === "string" ? value : JSON.stringify(value ?? (contract.type === "array" ? [] : {}), null, 2)} onChange={(event) => onChange(parseJsonValue(event.target.value))} /></label>;
  return <label className="project-field"><span>{labelText}{contract.required ? " *" : ""}</span><input type={contract.type === "number" ? "number" : name.toLowerCase().includes("url") ? "url" : "text"} value={value ?? ""} onChange={(event) => onChange(contract.type === "number" ? Number(event.target.value) : event.target.value)} required={contract.required === true} placeholder={projectInputPlaceholder(name)} /></label>;
}

function Projects({ data, onNewProject }) { return <div className="simple-screen"><header className="topbar"><div><span className="section-label">Workflow instances</span><h1>Projects</h1><p className="topbar-copy">一个 Project 是某个客户或策划案在一个固定 Workflow 版本上的运行实例。</p></div><div className="top-actions"><button className="primary" onClick={onNewProject}><Plus size={15} />新建项目</button></div></header><div className="project-table"><div className="table-head"><span>Project</span><span>Workflow</span><span>视频任务</span><span>Status</span><span>Updated</span></div>{(data?.instances ?? []).map((instance) => <div className="table-row" key={instance.id}><strong>{instance.name}</strong><span className="mono">{instance.workflowSha256.slice(0, 12)}</span><span>{instance.contentItems?.length ?? 0} 条 · {routeSummary(instance.contentItems)}</span><span>{instance.status}</span><span>{new Date(instance.updatedAt).toLocaleString()}</span></div>)}</div></div>; }

function Agents({ data }) {
  const agents = [...new Set([
    ...(data?.cards ?? []).map((card) => card.agentId),
    ...(data?.instances ?? []).flatMap((instance) => Object.values(instance.agentBindings ?? {})),
  ].filter(Boolean))];
  return <div className="simple-screen"><header className="topbar"><div><span className="section-label">OpenClaw workers</span><h1>Agents</h1></div></header><div className="agent-list">{agents.length ? agents.map((agent) => <div className="agent-row" key={agent}><span className="agent-avatar"><Icons.Bot size={18} /></span><div><strong>{agent}</strong><span>Workflow binding or native Workboard assignment</span></div><span className="live-dot" /></div>) : <p className="empty-copy">No agent binding has been declared.</p>}</div></div>;
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
  return ({ customerId: "客户 ID", briefUrl: "策划案 URL", authorizationScope: "执行权限" })[name] ?? name;
}

function projectInputPlaceholder(name) {
  return ({ customerId: "客户或合同中的稳定 ID", briefUrl: "https://..." })[name] ?? "";
}

function parseJsonValue(value) {
  try { return JSON.parse(value); }
  catch { return value; }
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
        projectId: project.id,
        projectName: project.name,
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
      isApproval: true,
      projectId,
      projectName: project.name,
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

function csv(value) { return value.split(",").map((entry) => entry.trim()).filter(Boolean); }
function slug(value) { return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, ""); }

function routeSummary(items = []) {
  const counts = items.reduce((result, item) => ({ ...result, [item.route ?? "待分流"]: (result[item.route ?? "待分流"] ?? 0) + 1 }), {});
  return Object.entries(counts).map(([route, count]) => `${route} ${count}`).join(" / ") || "待拆单";
}
