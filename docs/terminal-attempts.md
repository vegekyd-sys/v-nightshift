# 外部操作的终态尝试回执

默认完成契约不变：带 sideEffects 的阶段需要本卡所属的 succeeded 操作。只有明确想交付“尝试结果”、而非保证业务成功的阶段，才使用下述 opt-in。引擎不认识账号、坏号或重购策略。

```yaml
actor: agent
sideEffects: [paid-production]
approval: {before: paid-production, scope: project}
retry: {maxAttempts: 1, idempotencyKey: "${instance.id}:attempt"}
outputs: [attemptReceipt]
outputContracts:
  attemptReceipt: {type: json}
completeWhen: [output.attemptReceipt.exists]
operationCompletion: {mode: terminal-attempt, output: attemptReceipt}
```

同一 Workflow 必须声明 `spec.completion.mode: strict-v1` 和 `spec.handoff.version: 1`。仍需正常的 skills、timeout、执行来源证明和 handoff。此声明不批准付费、不增加轮次/预算，也不允许在同一阶段登记第二种操作。

## 如实登记和绑定

供应商回读证明任务已终结后，checkpoint 保持真实 `status: failed` 或 `succeeded`，并在 result 记录 `terminal: true`、非空 `evidence` 证据引用及必要供应商事实。网络超时、未查明订单、reserved、unknown、尚在 executing 都不是已知终态。`failed` 不等于未扣费；本契约中的“终态”不代表财务已对账或退款。

产物示意：

```json
{
  "attempted": true,
  "succeeded": false,
  "operation": {
    "idempotencyKey": "原账本操作键",
    "requestHash": "原请求SHA256",
    "externalTaskId": "原供应商任务ID，没有则为null",
    "status": "failed",
    "resultSha256": "operationResultHash(账本result)"
  }
}
```

`operationResultHash` 由 nightshift-core 导出：对 result 递归按对象键排序后 JSON 序列化，再 SHA-256；数组顺序保留。必须对实际已登记 result 计算，不对另一轮回执或聊天总结计算。服务端同时匹配 key、hash、task ID、状态与 result 摘要，并核对卡片归属；同一份读取到的产物再供完整输出契约校验，不能先过账本检查再换产物。

上面 false 表示外部尝试失败，**不是伪造登录/发布/业务成功**。它可以使“尝试执行”阶段完成，再由独立验证阶段读取回执及证据，输出业务事实。只有 Workflow 的显式结果路由才能决定退出、下一轮或停住；供应商失败并不自动等于资源不可用，更不自动授权补购。严格业务成功规则仍要求自身的真实成功事实。

## 恢复与防重

- 缺失/错配回执仍阻断；原失败账本不修改、不抹除。
- 已声明 terminal-attempt 且有明确终态证据时，V/既有继续按钮通过 `cards retry` 只恢复本卡、原键来补交回执，不新建修订或外呼；不需要 allow-new-operation，因为并未授权新操作。重复继续幂等。
- 同键 reserve 继续复用原 failed，不允许更换请求 hash。Agent brief 明确禁止重提；未知结果继续要求回读。
- 未声明的新旧 Workflow 保持原门槛及原 failed 换修订授权规则。审批、共享额度、暂停/归档和失败操作计数不变。
- 首次使用检查 `health.workflowFeatures.terminalAttempts === 1`，不能把该语法发给未升级服务。

## 验收

单元覆盖默认不放开、未知结果、回读证据缺失、回执身份/hash/状态/任务/result 摘要错配、假 succeeded、声明错误、V 与按钮恢复同卡且上游不变。私有真实 Gateway + 正式 HTTP 服务跑 failed checkpoint → 诚实尝试回执完成 → 独立验证否决 → 新轮 → 成功出口；保留旧 failed 和计数，重复 reserve 不多操作，零 Agent/供应商调用。业务 Workflow 还需用自身定义/产物完成隔离端到端适配，不能把合成验证当实机成功。
