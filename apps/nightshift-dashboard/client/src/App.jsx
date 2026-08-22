import React, { useEffect, useMemo, useState } from "react";
import YAML from "yaml";
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

  async function refresh(force = false) {
    setRefreshing(true);
    try { setData(await api(force ? "/api/bootstrap?refresh=1" : "/api/bootstrap")); setError(""); }
    catch (reason) { setError(reason.message); }
    finally { setRefreshing(false); }
  }

  useEffect(() => { refresh(false); const timer = setInterval(() => refresh(false), 5000); return () => clearInterval(timer); }, []);

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
    try {
      await api(`/api/cards/${card.id}/${status}`, {
        method: "POST",
        body: JSON.stringify({ actor: "Workboard operator", contentItemId, evidence, instanceId, stageId }),
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
        {active === "workflows" && <WorkflowDesigner data={data} refresh={refresh} />}
        {active === "projects" && <Projects data={data} />}
        {active === "agents" && <Agents data={data} />}
      </main>
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

function WorkflowDesigner({ data, refresh }) {
  const release = data?.workflows?.[0];
  const [source, setSource] = useState("");
  const [issues, setIssues] = useState([]);
  const [message, setMessage] = useState("");
  useEffect(() => { if (release?.sourceMarkdown ?? release?.sourceYaml) setSource(release.sourceMarkdown ?? release.sourceYaml); }, [release?.workflowSha256]);
  const parsed = useMemo(() => parseWorkflowAuthoringSource(source), [source]);
  async function validate() { try { const result = await api("/api/workflows/validate", { method: "POST", body: JSON.stringify({ sourceMarkdown: source }) }); setIssues(result.issues); setMessage(result.ok ? "Workflow is valid" : "Fix validation issues"); } catch (e) { setMessage(e.message); } }
  async function saveDraft() { const result = await api("/api/workflows/draft", { method: "PUT", body: JSON.stringify({ sourceMarkdown: source }) }); setIssues(result.issues ?? []); setMessage(result.valid ? "Draft saved" : "Draft saved with issues"); }
  async function publish() { await api("/api/workflows/publish", { method: "POST", body: JSON.stringify({ sourceMarkdown: source }) }); setMessage("Immutable release published in VLab"); await refresh(); }
  return <div className="workflow-screen"><header className="topbar"><div><span className="section-label">Workflow library</span><h1>Workflow Designer</h1></div><div className="top-actions"><button onClick={validate}>Validate</button><button onClick={saveDraft}>Save draft</button><button className="primary" onClick={publish}>Publish VLab release</button></div></header><div className="workflow-meta"><div><span>Workflow</span><strong>{parsed?.metadata?.name ?? "Invalid workflow.md"}</strong></div><div><span>Version</span><strong>{parsed?.metadata?.version ?? "—"}</strong></div><div><span>Stages</span><strong>{parsed?.spec?.stages?.length ?? 0}</strong></div><div><span>Release SHA</span><strong className="mono">{release?.workflowSha256?.slice(0, 12) ?? "draft"}</strong></div></div><div className="designer-grid"><section className="yaml-panel"><div className="panel-head"><h2>workflow.md</h2><span>唯一命令文件</span></div><textarea aria-label="Workflow Markdown" spellCheck="false" value={source} onChange={(event) => setSource(event.target.value)} /></section><section className="graph-panel"><div className="panel-head"><h2>Visual flow</h2><span>由同一份 Markdown 自动编译</span></div><div className="stage-flow">{(parsed?.spec?.stages ?? []).map((stage, index) => <div className="stage-node" key={stage.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{stage.title}</strong><small>{stage.scope ?? "project"} · {stage.actor ?? "agent"}</small></div>{index < parsed.spec.stages.length - 1 && <div className="connector" />}</div>)}</div>{issues.length > 0 && <div className="issues"><h3>Validation</h3>{issues.map((item) => <p key={`${item.path}-${item.code}`}>{item.path}: {item.message}</p>)}</div>}{message && <div className="toast-inline">{message}</div>}</section></div></div>;
}

function Projects({ data }) { return <div className="simple-screen"><header className="topbar"><div><span className="section-label">Workflow instances</span><h1>Projects</h1></div></header><div className="project-table"><div className="table-head"><span>Project</span><span>Workflow</span><span>视频任务</span><span>Status</span><span>Updated</span></div>{(data?.instances ?? []).map((instance) => <div className="table-row" key={instance.id}><strong>{instance.name}</strong><span className="mono">{instance.workflowSha256.slice(0, 12)}</span><span>{instance.contentItems?.length ?? 0} 条 · {routeSummary(instance.contentItems)}</span><span>{instance.status}</span><span>{new Date(instance.updatedAt).toLocaleString()}</span></div>)}</div></div>; }

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

function routeSummary(items = []) {
  const counts = items.reduce((result, item) => ({ ...result, [item.route ?? "待分流"]: (result[item.route ?? "待分流"] ?? 0) + 1 }), {});
  return Object.entries(counts).map(([route, count]) => `${route} ${count}`).join(" / ") || "待拆单";
}
