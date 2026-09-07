import React, { useState } from "react";
import { api } from "./api.js";

export function ExecutionControls({ instance, cards, refresh }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const automatic = instance.control?.automaticDispatch ?? true;
  const fault = instance.control?.fault;
  const prefix = `/api/instances/${encodeURIComponent(instance.id)}`;
  const eligible = cards.filter((card) => (card.labels ?? []).includes(`instance:${instance.id}`) &&
    !(card.labels ?? []).includes("nightshift:approval") &&
    (card.status === "ready" || ["running", "completing"].includes(card.humanAttempt?.status)));
  async function act(path, body = {}) {
    setBusy(true);
    setError("");
    try {
      await api(`${prefix}/${path}`, { method: "POST", body: JSON.stringify({ actor: "Workboard operator", ...body }) });
      await refresh(true);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  }
  return <section className="execution-controls" aria-label={`${instance.name} 执行控制`}>
    <div className="execution-controls-head"><strong>{instance.name}</strong><span>{automatic ? "自动派工开启" : "自动派工已暂停"}</span>
      <button disabled={busy} onClick={() => act("dispatch-control", { automaticDispatch: !automatic })}>{automatic ? "暂停自动派工" : "开启自动派工"}</button></div>
    {fault && <div role="alert" className="execution-fault"><strong>调度失败 · {fault.stageIds?.join("、") || "项目调度"}</strong><p>{fault.message}</p>
      <button disabled={busy || !automatic} onClick={() => act("retry-dispatch")}>仅重试此项目</button></div>}
    {!automatic && eligible.length > 0 && <div className="execution-takeover"><label>接管原因<input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明本次人工接管的原因" /></label>
      {eligible.map((card) => <div className="execution-card" key={card.id}><span>{card.title || "待执行任务"}</span>
        {card.humanAttempt ? <><small>人工执行 · {card.humanAttempt.actor}</small><button disabled={busy} onClick={() => act(`cards/${encodeURIComponent(card.id)}/human-complete`)}>校验产物并完成</button></> :
          <button disabled={busy || !reason.trim()} onClick={() => act(`cards/${encodeURIComponent(card.id)}/human-takeover`, { reason })}>接管此卡</button>}</div>)}
      <p>接管保留原卡。完成前请按 Workflow 写入真实 handoff 和产物，系统会校验后再创建下游。</p></div>}
    {error && <p role="alert" className="execution-fault">{error}</p>}
  </section>;
}
