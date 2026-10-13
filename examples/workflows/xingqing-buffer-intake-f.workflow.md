---
apiVersion: nightshift.versa.ai/v1alpha1
kind: Workflow
metadata:
  id: xingqing-buffer-intake-f
  version: 0.1.0
  name: 星擎 F 入池排期（测试专用，其他人勿用）
spec:
  ownerAgentRole: content-operator
  requiredCommands: [lark-cli, nightshiftctl, ffprobe]
  concurrency: {perInstance: 1}
  completion: {mode: strict-v1}
  handoff: {version: 1, mode: stage-input-output}
  notifications:
    instanceCompleted: {enabled: true}
  inputs:
    sourceProjectId: {type: string, required: true}
    sourceInstanceDir: {type: string, required: true}
    enterpriseName: {type: string, required: true}
    planningDocUrl: {type: string, required: true}
    acceptedItems: {type: array, required: true}
    rejectedItemIds: {type: array, required: true}
    publicationTarget: {type: object, required: true, requiredProperties: [accountRecordId, tiktokHandle, geelarkDeviceId, market, language, timezone]}
    testScope: {type: object, required: true, requiredProperties: [serviceRecordId, periodStartLocalDate, periodEndLocalDate, scheduleLocalTime, publishCount, workdays]}
    bufferTarget: {type: object, required: true, requiredProperties: [baseId, tableId]}
    reviewConfirmation: {type: object, required: true, requiredProperties: [confirmed, manifestHash, selectionHash, confirmedBy, confirmedAt]}
    authorizationScope: {type: object, required: true, requiredProperties: [paidProduction, externalPublication]}
---

# 星擎 F 入池排期

这是交付页确认后交给 Agent 的后台任务，只写已经确认的成片和排期，不制作视频、不提交 GeeLark 发布任务。实例 inputs 是已冻结的确认集合；不通过的 id 不写池子。本阶段一份 v1 交接单写在 `handoffs/buffer-intake.json`，将输出指向本实例内的真实结果文件。

## STAGE buffer-intake｜确认成片入池并补位排期

### Goal

把本批已确认的 acceptedItems 写入现有成片 Buffer 池，按这个账号本周期工作日1条、最多5条的需求补位。先核实 reviewConfirmation.confirmed 为 true，并用 lark-base 只投影非敏感字段回读指定服务记录和账号，确认仍在服务期中、账号已登录且企业/市场/语言/云机与 publicationTarget 一致；不符就停住说明缺什么，不猜号。

从 sourceInstanceDir 内的本批 brief 和 planningDocUrl 了解每条内容，用 tiktok-publish-copy 为每条生成通过自检的文案，写 `buffer-intake/copies.json`（`items[]` 每条含 contentItemId、videoDesc、qc.status）。用 ffprobe 检查每个已确认链接确实能读取且成片为1080×1920；没有实测证据或规格不符时先停住，不把旧片/720p导出件写入发布池，不重做付费视频。

用 lark-base 读取 bufferTarget 的真实字段和该企业、市场、语言的现有池记录，最少投影：条目标识、企业名称、视频文件URL、目标账号、云机ID、国家市场、语言、时区、发布文案、状态、计划发布时间(UTC)、计划发布时间(当地)、上传时间。完整查询保存为 `buffer-intake/pool.ndjson`。先保留已排期/发布中/已发布的位置，再处理已确认待排期库存和本批新片；不覆盖别的账号或原排期。

调用 `nightshiftctl intake-plan`，输入本实例 `project-inputs.json`，`--pool buffer-intake/pool.ndjson --copies buffer-intake/copies.json --output buffer-intake/plan.json`。它只计算计划、不写表：先安排更早的可排期库存，再补本批片子；超额度的新片写待排期，不擅自安排到下个周期。同账号的入池任务由 resourceLock 串行执行。需要时重查池子再重算；不得绕过已经占用的位置。

按 plan.json 的写入项用 lark-base upsert：已有记录只按真实 recordId 更新计划字段；新条目以 `条目标识=sourceProjectId:contentItemId` 查询并写入，一条只入池一次。写完回读真实记录，把每个已确认 contentItemId 对应的 recordId 保存到 `buffer-intake/result.json`，含 `recordedAll:true`、submittedCount、scheduledCount、pendingCount、records。发生部分失败时保留已写的记录和结果，续跑先按条目标识对账，只补缺项，不重写成功部分。完成前由服务端再独立回读 Base 校验字段、周期、同日冲突及数量，不能用自己声明成功代替真实回读。

本阶段有 external-delivery 副作用，按引擎注入的外部操作台账登记整个确认批次：写池前 reserve，处理中 executing，全部回读成功后 succeeded；按同一个幂等键续跑。状态“已排期”不是“已发布”。缺少只有人能补的条件，最后两行写“需要人做：<具体动作>”“原因：<事实>”；暂时接口故障可自行恢复时写“需要人做：无”，不新增同批任务。

```stage
actor: agent
scope: project
skills: [lark-base, lark-doc, lark-shared, tiktok-publish-copy]
sideEffects: [external-delivery]
resourceLock: "bf:${input.publicationTarget.geelarkDeviceId}"
outputs: [intakeResult]
outputContracts:
  intakeResult: {type: json, equals: {recordedAll: true}}
completeWhen: [output.intakeResult.recordedAll]
timeout: 1h
retry: {maxAttempts: 3, idempotencyKey: "${instance.id}:buffer-intake"}
```
