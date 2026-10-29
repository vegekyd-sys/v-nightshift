# 超时调用的有界时间恢复

普通 `cards retry` 和 `operations authorize-recovery` **不延长时间**。旧版本没有已超时调用的时间恢复入口；修改数据库、复制项目、换轮次或重新发布 SHA 都不是恢复方式。

本接口引入后须先确认 `health.workflowFeatures.callTimeRecovery = 1`。它仅解决**原调用时间耗尽**，不把供应商限流、未知结果、账户或出口 hold、凭据暴露当成已解决。

## 正式入口

读取原项目 / 调用的当前 `deadline` 与原任务结果，确认相关操作已知终态、有实际回执，且原有授权仍有效。项目、子执行和祖先需处于允许执行的状态。调用方从有效授权范围内选择**绝对**的新截止时间：

```sh
nightshiftctl calls authorize-time-recovery <原call-id> \
  --expected-deadline <回读的原deadline，ISO或epoch毫秒> \
  --until <新绝对截止时间，ISO或epoch毫秒> \
  --actor V \
  --reason '明确的恢复原因' \
  --authorization '已有且仍有效的执行授权引用' \
  --evidence '原任务终态及恢复条件的证据引用'
```

等价 API：`POST /api/calls/:callId/authorize-time-recovery`，JSON 字段为 `expectedDeadline / deadline`（整数 epoch 毫秒）及 `actor / reason / authorization / evidence`。公开入口沿用已认证身份，本机使用现有 `local:<actor>` 规则；不能伪称用户点击。

## 时间许可的边界

- 只针对当前未被替代、未跳过、未禁用的最后一轮；必须已经超时且仍 running，或明确 held 在 `duration-limit`。尚未到期、成功/继续/其他 hold 原因不能使用。支持尚未被下一次调度投影为 held 的已过期调用。
- 新期限必须在未来，且从原期限起追加的时间不超过一段声明的调用时长，即 `min(stage.timeout, repeat.maxDuration)`；没有 repeat 则使用 `stage.timeout`。它不是从每次请求的“现在”重新加时。
- 新期限不能越过根项目、父/子 Workflow 自己声明的时长上限，也不能越过任一祖先调用期限。**不延长根项目，不扩操作次数、循环轮数或金额授权。**
- 每个控制卡的整个循环历史最多一个许可；同一请求重复返回同一审计记录，不再推进截止时间，不复活已完成/再次过期的调用。不同轮次也不能再次申请。
- 同一控制单元历史及其子树存在 reserved / executing / unknown 操作，或终态操作缺实际结果时，先读回原任务，不能继续加时。其他独立名额的在途任务不被重提或取消。
- 暂停、自动派工关闭、禁用/跳过、被新控制卡或新轮次替代、祖先超时均阻断新的许可。

## 保留与接续

事务中仅更新原调用的截止时间及运行状态，并写 append-only 审计事件 `workflow.call.time-recovery-authorized`。事件记录原/新期限、原父子执行、控制卡、轮次、固定 SHA、actor、原因、授权及证据；无 SQLite 结构迁移。公开调用摘要保留 `originalDeadline / deadline / timeRecoveryId`，后续轮次继承**同一**恢复期限。

不创建新卡、子执行或轮次，不清账本、失败计数、成本或旧回执，不更改已发布 Workflow。许可会唤醒正常调度，但**不会直接 retry 子卡或提交供应商**；子卡自身的失败、审批或 hold 仍须按原正式入口处理。

若外部操作次数也耗尽，时间许可后仍须单独满足 [有界操作恢复许可](operation-recovery.md)，不能把时间许可当作花钱许可。普通 retry 也不能绕过这些限制。`authorization` 是审计依据，不是引擎对金额或外部准入的证明，调用者仍需核算实际费用及承诺支出。

## 验收与上线前限制

`lab/candidate/call-time-recovery-http-scenario.mjs` 使用私有 Gateway / 真实 Workboard / 正式 HTTP API，走真实过期时钟，验证超时阻断操作许可、拒绝过长追加、重复时间许可幂等、保留原 call/child/card/round，然后完成操作恢复及成功出口。仅合成供应商事实，远期卡片不派 Agent，零供应商外呼。

单元回归覆盖 SQLite 重开、固定期限重放、后续轮次共享许可、父/祖先/根期限、暂停与禁用、被替代、相关未知结果和独立名额隔离。测试通过不代表生产已部署，更不代表真实资源已经满足登录准入。合入、上线仍遵守仓库流程。
