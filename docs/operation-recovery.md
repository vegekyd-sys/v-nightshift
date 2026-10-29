# 已知失败后的有界恢复许可

普通 `cards retry --allow-new-operation` 或决定「继续」只创建受控新尝试，**不增加操作次数上限**。失败操作仍计数；不会因为 `failed` 自动认为免费、已退款或可以继续花钱。

## 正式入口（需 health.workflowFeatures.operationRecovery = 1）

先核实供应商明确失败、旧任务没有在途/未知结果，并通过已有 `cards retry`/`decisions decide` 获得同阶段的新尝试。新卡尚未登记外部操作，且调用未被替代或超时、项目未暂停、执行授权有效时，可在原授权范围内显式申请 **一次** 追加许可：

```sh
nightshiftctl operations authorize-recovery <新恢复卡ID> \
  --failed-operation <原failed操作键> \
  --request-hash <修正请求的SHA256> \
  --actor V \
  --reason '明确的修正原因' \
  --authorization '原授权依据及仍然有效的预算范围' \
  --evidence '供应商终态证据引用'
```

等价 API：`POST /api/cards/:cardId/operations/authorize-recovery`，正文为 `failedOperationKey / requestHash / actor / reason / authorization / evidence`。公开入口的 actor 使用已认证操作人；本机沿用现有 `local:<actor>` 规则。

引擎从真实卡片解析执行、阶段和新操作键，不接受调用者改写坐标或额度。许可绑定原失败回执快照、紧邻的新尝试卡、固定 Workflow SHA、请求 hash 及当时耗尽的子执行/祖先 call 约束；每个失败操作最多授权一个后继操作。重复提交返回同一许可，修改 hash 需重新调查，不能靠重复授权换绑定。

随后仍使用原 `operations reserve`/`checkpoint`，不另造提交供应商的通道。事务中校验许可并登记；中断后重放不多登记。另一张卡、另一个请求或其他名额不能借用未消费许可。原失败键和回执原样保留；展示实际累计次数和「含恢复许可 N 次」。

## 不会扩大什么

- 根项目总操作上限不变；本入口不能扩根项目额度，也不能把零操作的调用变为可外呼。
- 所有嵌套 workflow 自己的 `spec.limits` 和祖先 call 限制都需要满足。旧版本 reserve 漏检子执行自己的 `spec.limits`，本次一并补齐；这不修改旧声明或 SHA。
- 轮数、耗时、暂停、审批、结果未知阻断不变。存在相关在途操作时不能授权；根项目其他独立名额的在途操作不会因此被重提或取消。
- **次数不是金额预算。** `authorization` 记录依据，不把文本或额度许可当作新的货币授权，也未新增金额硬预算能力。调用者仍须核算实际费用、剩余额度及资源准入。
- 普通重试/「继续」不隐式申请许可，也不自动采购、建机或重新认证。

调用已经超时时，本操作许可仍然拒绝。支持 `callTimeRecovery` 的版本可先按 [有界时间恢复](call-time-recovery.md) 单独取得时间许可；它不增加操作次数或解除其他 hold，再核对本页条件后才可申请操作许可。

许可保存在现有 append-only 审计事件 `external-operation.recovery-authorized` 中，不做 SQLite 结构迁移，不写已发布 Workflow、业务项目输入或旧账本。

## 决定入口

`GET /api/decisions?instanceId=<根项目>` 默认汇总其调用树。记录的 `instanceId` / `executionInstanceId` 仍是原执行，`rootInstanceId` 是所属项目；决定 POST 仍只操作原决定。`includeDescendants=false` 可只读当前执行。

通知保留根项目上下文，并携带 `card=<原任务ID>`；多组决定分别提供任务链接。根项目及总览「需要你」包含子决定，深链抽屉按原决定打开，不回退成不适用的普通重试。已经 decided 的记录不会重新变为 open，修复不伪造任何历史点击。

## 验收

`lab/candidate/bounded-recovery-http-scenario.mjs` 通过正式 API 和真实 Workboard 验证默认完成门槛拒绝真实 failed、根查到子决定、决定生成同轮 attempt2、未授权被限额拒绝、显式许可与并发重复调用幂等、错 hash 拒绝、旧 failed 不变、成功后只放行一次下游。全部供应商回执为合成事实，卡片固定远期执行时间，不派发 Agent，不调用供应商。

额外回归覆盖 SQLite 重开、子执行独立限额、根额度不变、零操作拒绝、暂停/被替代/未知/变更回执阻断，以及 UI inbox/抽屉和通知深链。生产原案例接续需先部署本版本，核实原卡状态、期限、剩余预算和准入，再由任务执行方使用上述正式入口；测试通过不代表已执行真实外呼。
