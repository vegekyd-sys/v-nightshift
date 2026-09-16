---
apiVersion: nightshift.versa.ai/v1alpha1
kind: Workflow
metadata:
  id: xingqing-content-delivery
  version: 0.5.0
  name: 星擎内容交付
spec:
  ownerAgentRole: content-operator
  concurrency: {perInstance: 8, maxActiveInstances: 3}
  completion: {mode: strict-v1}
  handoff: {version: 1, mode: stage-input-output}
  contentItems:
    routes: [AI_GENERATE, SCENE_EDIT]
    maxItems: 30
    source: output.contentItemsManifest
  inputs:
    customerId: {type: string, required: true}
    briefUrl: {type: string, required: true}
    authorizationScope: {type: object, required: true}
    deliveryMode: {type: string, required: false, enum: [publish, download]}
    publicationTarget:
      type: object
      required: false
      requiredProperties: [accountRecordId, tiktokHandle, geelarkDeviceId, platform, market, language, timezone]
---

# 星擎内容交付 Workflow

这份文件是星擎夜班模式的唯一命令文件。同一版本可以启动多个客户、多个策划案实例；运行状态、成片和审核都进入统一 Workboard。

## STAGE plan｜策划读取与任务拆分

### Goal

读取或修订策划案，把其中每条计划视频拆成独立 ContentItem；不得把整份策划压成一个全局 route。

```stage
actor: agent
scope: project
skills: [lark-base, lark-doc, max-qijian-planning-doc]
outputs: [requirementSnapshot, planUrl, contentItemsManifest]
completeWhen: [output.requirementSnapshot.traceable, output.planUrl.reachable, output.contentItemsManifest.hasAtLeastOneItem, output.contentItemsManifest.everyItemHasStableIdAndTitle]
timeout: 30m
retry: {maxAttempts: 2, idempotencyKey: "${instance.id}:plan:${input.hash}"}
next: [route]
```

## STAGE route｜逐条路线判断

### Goal

对当前视频任务单独判断 AI_GENERATE 或 SCENE_EDIT。素材缺失是等待状态，不是第三条生产路线。

```stage
actor: agent
scope: content-item
requiresRoute: false
skills: [lark-doc, material-verification]
needs: [plan]
outputs: [routeDecision]
completeWhen: [output.routeDecision.routeAllowed, output.routeDecision.evidenceLinked, output.routeDecision.constraintsExplicit]
timeout: 15m
retry: {maxAttempts: 2, idempotencyKey: "${instance.id}:${contentItem.id}:route:${input.hash}"}
next: [materials]
```

## STAGE materials｜素材准备

### Goal

按当前 ContentItem 的路线准备并冻结可追溯生产输入；缺素材时进入人工等待子状态。

```stage
actor: agent
scope: content-item
routeStrategies:
  AI_GENERATE:
    skills: [lark-doc, scene-cli, material-verification]
    description: 冻结授权的产品图、品牌事实、视觉参考和生成约束；不得伪造客户事实。
  SCENE_EDIT:
    skills: [shooting-checklist-v3, scene-cli, material-verification]
    description: 从 Scene 验真并冻结 source_url、start_sec、end_sec；缺镜头时创建拍摄和上传待办。
needs: [route]
outputs: [materialReadiness, frozenInputManifest]
completeWhen: [output.frozenInputManifest.accessible, output.frozenInputManifest.routeFit, output.frozenInputManifest.sourcesTraceable]
humanTask: {when: output.materialReadiness.missingRequiredAssets, title: 完成拍摄或补充授权素材后上传 Scene}
timeout: 7d
retry: {maxAttempts: 2, idempotencyKey: "${instance.id}:${contentItem.id}:materials:${input.hash}"}
next: [brief]
```

## STAGE brief｜Brief 编译

### Goal

把策划、路线和冻结素材编译为当前视频唯一、可执行、不可变的 FinishedVideoBrief。

```stage
actor: agent
scope: content-item
routeStrategies:
  AI_GENERATE:
    skills: [finished-video-brief, lark-doc, makaron]
    description: 先按 finished-video-brief 契约生成 AI 视频 Brief，再交给 Makaron；包含镜头目标、参考资产、提示约束、品牌事实、时长画幅和验收条件。
  SCENE_EDIT:
    skills: [montage-script-writer, scene-cli]
    description: 生成剪辑 Brief，包含逐段 Scene 绑定、时间范围、叙事结构、字幕音频规则和验收条件。
needs: [materials]
outputs: [finishedVideoBrief]
completeWhen: [output.finishedVideoBrief.routeMatchesContentItem, output.finishedVideoBrief.inputsFrozen, output.finishedVideoBrief.productionReady]
timeout: 30m
retry: {maxAttempts: 2, idempotencyKey: "${instance.id}:${contentItem.id}:brief:${input.hash}"}
next: [produce]
```

## STAGE produce｜生产与机器 QC

### Goal

严格执行 FinishedVideoBrief，生成当前视频的新成片并完成逐条机器 QC 和交付清单。

```stage
actor: agent
scope: content-item
routeStrategies:
  AI_GENERATE:
    skills: [finished-video-brief, makaron, background-worker-contract]
    description: 只执行当前 AI_GENERATE ContentItem 的冻结 Brief，并生成可审计的逐条交付与 QC。
  SCENE_EDIT:
    skills: [finished-video-brief, makaron, background-worker-contract]
    description: 只执行当前 SCENE_EDIT ContentItem 的冻结 Brief，并运行时间维度重复/近重复检测。
needs: [brief]
sideEffects: [paid-production]
approval: {before: paid-production, scope: content-item}
outputs: [finishedAsset, machineQc, deliveryManifest]
completeWhen: [output.finishedAsset.newForThisRun, output.machineQc.terminal, output.deliveryManifest.accessible]
timeout: 4h
retry: {maxAttempts: 3, idempotencyKey: "${instance.id}:${contentItem.id}:produce"}
next: [review, deliver-download]
```

## STAGE review｜人工审核与交付

### Goal

在 Workboard 同一张视频任务卡中查看策划、Brief、成片、工程和 QC，批准、退回修改或拒绝。

```stage
actor: human
scope: content-item
needs: [produce]
when: {input: deliveryMode, notEquals: download}
approval: {actions: [approve, request-changes, reject], evidenceRequired: true}
outputs: [approvedAssetVersion]
timeout: 3d
next: [publish-feedback]
```

## STAGE publish-feedback｜发布与反馈

### Goal

使用 geelark-cloud-phone 将已批准版本发布到授权的 TikTok 账号，回收真实 TikTok 链接与数据，并形成下一轮建议；没有 publicUrl 和发布证据时不得报告完成，等待统计属于本阶段子状态。

```stage
actor: agent
scope: content-item
skills: [lark-base, social-search-apify-first, geelark-cloud-phone]
needs: [review]
when: {input: deliveryMode, notEquals: download}
sideEffects: [external-publication]
approval:
  before: external-publication
  scope: asset-and-account
  bindings:
    publicationTarget:
      source: input.publicationTarget
      requiredFields: [accountRecordId, tiktokHandle, geelarkDeviceId, platform, market, language, timezone]
resourceLock: "geelark:${input.publicationTarget.geelarkDeviceId}"
outputs: [publishTask, publicUrl, publicationEvidence, metricsSnapshot, retrospective]
outputContracts:
  publicUrl: {type: https-url, allowedHosts: [tiktok.com]}
  publicationEvidence:
    type: json
    equals: {platform: tiktok, published: true, accountMatches: true}
    matches: {publicUrl: output.publicUrl.url}
completeWhen: [output.publicUrl.hostAllowed, output.publicUrl.reachable, output.publicationEvidence.published, output.publicationEvidence.accountMatches, output.publicationEvidence.publishedAt, output.metricsSnapshot.traceableOrUnknown, output.retrospective.evidenceLinked]
timeout: 7d
retry: {maxAttempts: 4, idempotencyKey: "${instance.id}:${contentItem.id}:publish-feedback"}
```

## STAGE deliver-download｜下载包交付

### Goal

仅当 `deliveryMode=download` 时执行：等待全部 ContentItem 完成生产与机器 QC，聚合已验证成片和交付清单，生成确定性下载包，上传授权 OSS，并幂等回写 Base 交付记录。不得创建逐条人工审核、外部发布审批或 GeeLark 发布任务。

```stage
actor: agent
scope: project
skills: [lark-base, background-worker-contract]
needs: [produce]
when: {input: deliveryMode, equals: download}
sideEffects: [external-delivery]
resourceLock: "delivery:${instance.id}"
outputs: [deliveryPackage, ossDelivery, baseDeliveryReceipt]
outputContracts:
  deliveryPackage: {type: file}
  ossDelivery: {type: json, equals: {uploaded: true}}
  baseDeliveryReceipt: {type: json, equals: {recorded: true}}
completeWhen: [output.deliveryPackage.accessible, output.ossDelivery.uploaded, output.baseDeliveryReceipt.recorded]
timeout: 1h
retry: {maxAttempts: 3, idempotencyKey: "${instance.id}:deliver-download:${input.hash}"}
```
