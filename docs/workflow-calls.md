# 可复用 Workflow 调用与有界循环

本能力由 PR 引入，只有部署含此能力的 release 后才能用于创建项目。它不是任意 DAG 回边、普通 retry，也不包含自动补购策略。

## 模型与兼容

普通 Workflow 不变。一个 `actor: workflow` 阶段调用另一个已发布的 **SHA-256** release；内部仍是现有 Runtime、Workboard、审批、handoff 和外部操作账本。调用上下文归属原项目，不是新的顶层业务项目。子流程可再次调用已发布流程，最多八层；不能自引用、使用 latest 或在运行时偷偷升级。

流程定义只维护一份：不写 `repeat` 时调用一次；加 `repeat` 后按输出路由；把调用阶段设为 `scope: content-item` 时每条目独立运行（仍遵守现有 route 要求，或显式 `requiresRoute: false`）。成功条目不重做，项目下游等待所有应交付条目的调用成功。

可运行格式见 [被调用流程](../examples/workflows/reusable-verified-work.workflow.md) 和 [调用方](../examples/workflows/repeat-verified-work.workflow.md)。先发布被调用 release，再发布调用方；修改被调用内容时显式更换版本及 SHA。示例的上限不是实际付费授权。

## 输出边界

被调用 Workflow 用 `spec.outputs` 导出已有项目阶段的 JSON 产物：

```yaml
spec:
  outputs:
    result: {stage: verify, output: result}
```

`verify` 仍按原有 handoff/completeWhen/outputContracts 完成，并登记 `result.json`。文件必须属于当前执行目录，handoff 的 instance/stage 身份必须匹配；事实文件最多 64 KiB，不接收聊天总结、远程 URL 或上轮文件。逐条目结果先用现有项目聚合阶段汇总，再导出。大文件/媒体导出资源引用，不把媒体塞进事实 JSON。相对业务路径不会被引擎猜测重写，应导出带归属的可追溯资源引用。

验证得到业务不通过时，可正常完成验证卡，输出事实，例如 `{accepted:false,retryable:true,evidence:...}`。技术故障、缺失产物仍是执行失败，恢复同轮；不要用技术报错表示业务结论。只有被调用 Workflow 完成且导出可读，控制器才消费结果。

外部操作本身失败时，默认付费完成门槛仍要求 succeeded。需要交付明确失败尝试的阶段，显式使用 [terminal-attempt 契约](terminal-attempts.md)，保留 failed 及回读证据；未经该声明不能靠新轮次绕过完成校验。尝试终态不等于财务已结算，也不等于资源不可用。

## 调用声明

```yaml
actor: workflow
scope: content-item
requiresRoute: false
timeout: 2h
outputs: [result]
call:
  workflow: <64位已发布SHA>
  inputs:
    brief: {from: input.brief}
    slot: {from: item.id}
    reuseAllowed: {from: previous.result.reuseAllowed, default: false}
    resourceRef: {from: previous.result.resourceRef}
    options: {value: {quality: standard}}
repeat:
  until: {output: result.accepted, equals: true}
  while: {output: result.retryable, equals: true}
  maxIterations: 3
  maxDuration: 2h
  maxOperations: 0
```

- 输入显式绑定 `input`（调用者输入）、`item`（当前条目）、`previous`（上一轮导出）；首轮没有 previous。`default` 仅用于缺失值，false/0/null 是实际值；`value` 表达 JSON 字面量。不能重绑 nightshift、governance、authorizationScope；项目的已有授权只继承，不由绑定制造。
- 不带 repeat 时仅运行一次；`call.maxOperations` 限制其外部操作数，省略为 0。一次调用仍受 timeout 约束。
- repeat 的两个条件和三个上限都必须显式声明。条件是类型严格的标量 `equals`，不执行脚本。`until` 匹配优先退出；否则 `while` 匹配才新开一轮；两者均不匹配、字段缺失或类型不符即停住，不猜测失败原因。
- 调用阶段不能声明 skills/sideEffects/approval/releaseAt：这些仍在真正执行的内部阶段声明，并照常 preflight 和审批。
- 不识别“坏号”等业务词汇。验证事实和继续规则由业务 Workflow 定义，不能凭次数耗尽、出口限制或未知回执判断应该换资源。

## 成功、循环与恢复

成功：验证产物通过 `until` → 调用记录 succeeded → 导出复制到调用方 handoff → 调用控制卡 done → 现有依赖放行下游。没有新增判断 Agent 或人工按钮。

继续：明确的完整结果通过 `while`，且轮数/耗时许可 → 持久化下一轮上下文 → 新一轮的入口卡。旧轮卡、结果和操作原样保留；传入的资源只表示可复用引用，具体准备步骤仍应核验资源。循环不会自动清空卡片或重买全部资源。

恢复：同轮卡中断，V 用现有 `nightshiftctl cards retry <child-card-id> --actor V --note ...`；只有现有失败操作确需新修订且已授权时才加 `--allow-new-operation`。重试次数、修订号、业务轮次是不同身份。调用控制卡的 retry 只重新检查本轮已完成的输出/回执，不强制开启下一轮、不增加额度。技术阻塞恢复实际 child card，不重跑整个调用。

结果未知：reserved/unknown/未结算 executing 阻止下一轮和成功出口，要求供应商回读。不能通过“新轮次”换掉未知订单。failed 不代表零扣费；失败预留仍消耗外部操作次数。

可观察性：`projects get`/overview 返回 calls（轮次、状态、原因、子执行/卡 ID、操作次数）；只返回摘要，不透传导出内容或输入。看板显示轮次，并提供子卡链接，沿用原有操作入口。根项目暂停/关闭 dispatch/归档、调用被禁用/跳过/替代后，不得通过子调用派工或新 reserve；已提交任务的回执仍可落账。暂停不意味着替用户撤销供应商任务。

## 上限与事务

- 每个调用单元跨轮共享 maxOperations，所有嵌套调用同时受每层祖先额度约束。
- 项目可选 `spec.limits: {maxOperations: 8, maxDuration: 4h}`，所有条目、调用、嵌套调用和直接阶段共享项目操作额度。预留在 SQLite 写事务内先校验再计入；重复 reserve 复用旧记录，不重复扣额度，改 hash 仍拒绝。
- **操作次数不是金额预算，也不等于供应商账单。** 本版没有货币结算、退款或实际金额硬上限；若任务需要金额硬闸，必须由供应商/既有授权机制提供，不能写一个 money 字段假装引擎已执行。
- 下一轮 identity 由 parent/stage/item/attempt/iteration 确定；SQLite 唯一约束和创建事务保证上下文/归属一起提交。原有 Workboard 幂等键保护卡片重放；子执行即使自定义静态操作模板也加调用隔离后缀。控制器结果可重放，成功不会多放行一次。
- 项目/全局实际 dispatch 额度共享，不给每个子流程另发一份全局并发预算。

## 首版边界与回滚

不迁移已开始的生产项目，不修改旧 release、卡或操作键；不把同一阶段的第二种外部操作伪装成下一轮。阶段内多 operation、任意 goto、原地切换进行中的项目、跨调用边界 redo 不在本版范围；后者显式拒绝，应恢复原子卡或走声明的结果路由。没有新增真实业务 Workflow 发布或采购测试。

新增 workflow_calls 表与隐藏的内部实例行；旧表键不重写。回滚引擎前必须暂停并确认所有新调用已停住，否则旧引擎不理解内部上下文，不能直接降级后放开调度。保留 DB 备份及新账本，不删除审计。子执行工作目录的自动媒体回收不包含在此 PR，按资源生命周期另行设计。

## 验收

本地测试覆盖：固定 SHA、单次/循环共用定义、首轮默认值、输出缺失/类型/身份、成功出口一次、只循环失败条目、资源/旧回执保留、自定义键跨轮隔离、技术恢复同轮、SQLite 重开、并发重放、未知结果、操作/轮次/时间上限、祖先和项目共享预算、暂停/跳过/替代、嵌套调用、旧工作流兼容。

私有 Gateway candidate 使用真实 Workboard 和 SQLite 跑失败→第二轮→成功、读取真实 native key、重复消费/重开、未知回执阻断；不派发 Agent、不调用供应商。示例通过真实编译器并在临时库发布/建立，不能仅验证 YAML 外形。构建看板与交付页，CI 全绿后 PR 待审。上线后仍须共享 VLab 和浏览器验收，再考虑获明确授权的真实业务小样；本轮不执行。
