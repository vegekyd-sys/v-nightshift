# Night Shift 独立复验

验收必须区分引擎 canary 和业务媒体交付。`ns-attempt-canary` 只写一个真实 JSON 和 handoff，不生成付费媒体，不对外发送。

生产 release 的 `packages/nightshift-core/test/fixtures/auditable-attempt.workflow.md` 是测试工作流；同目录 `nightshift-audit-canary/SKILL.md` 是可复现的测试 Skill 源。安装目标是 Agent 实际 workspace 的 `skills/nightshift-audit-canary/SKILL.md`。它作为复验依赖保留，不在交接前归档。先用 `skills.status` 验证目标 Agent 能看到它，再发布这个固定工作流；不能用临时缺 Skill 推断生产自动派工失败。

复验顺序：

1. 保存当前项目控制状态和非目标 ready 卡的 status/sessionKey/runId。不要暂停、解冻或移动他人卡。
2. 创建唯一实例名的哨兵，`automaticDispatch:false`；确认产生 ready 卡。
3. 创建另一个唯一实例名的自动 canary，`automaticDispatch:true, dispatch:false`。`dispatch:false` 只跳过创建请求内派工，后台定时调度必须自行启动它。
4. 核验 ready → running 不超过 60 秒、原生 sessionKey/runId、真实 `result.json` 和 `handoffs/plan.json`、最终 done、唯一 review 下游；核对哨兵和其他 ready 卡没有被启动。
5. 若复验人工路径，另建自动派工关闭的实例，走 human-takeover → 缺产物时拒绝 → 写入真实产物与 handoff → human-complete；不能手动拖到 done 充当验证。
6. 检查 `/api/health` 的 `lastSchedulerAt` 连续推进、`lastSchedulerDurationMs`、`lastSchedulerError`、`schedulerRunning`。HTTP 200 只代表接口可达，必须同时检查 JSON 中的 `ok`。超时后要取得新的成功轮次，不能只看历史错误字符串被清空。
7. 测试完成后只暂停本次 canary 实例，保留 Skill、实例及证据供独立核验。

后台每轮使用一次权威看板快照；项目派工仍只使用该项目的精确卡 ID。一个项目派工失败不能阻止其他项目完成调度。共享快照读取失败会投射到所有 active 项目，下一次成功读取并完成对应 tick 后清除读取故障；未成功启动的派工故障不会因此清除。

生产上的复验始终遵守既有发布与实例权限边界；此说明不授权全板派工或启动业务媒体批次。
