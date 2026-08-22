---
apiVersion: nightshift.versa.ai/v1alpha1
kind: Workflow
metadata:
  id: xingqing-content-delivery
  version: 0.4.1-draft
  name: 星擎内容交付
spec:
  ownerAgentRole: content-operator
  concurrency: {perInstance: 4, maxActiveInstances: 3}
  contentItems:
    routes: [AI_GENERATE, SCENE_EDIT]
    maxItems: 30
    source: output.contentItemsManifest
  inputs:
    customerId: {type: string, required: true}
    briefUrl: {type: string, required: true}
    authorizationScope: {type: object, required: true}
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
    skills: [shooting-checklist-v2, scene-cli, material-verification]
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
    skills: [lark-doc, makaron]
    description: 生成 AI 视频 Brief，包含镜头目标、参考资产、提示约束、品牌事实、时长画幅和验收条件。
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
skills: [makaron, background-worker-contract]
needs: [brief]
sideEffects: [paid-production]
approval: {before: paid-production, scope: content-item}
outputs: [finishedAsset, machineQc, deliveryManifest]
completeWhen: [output.finishedAsset.newForThisRun, output.machineQc.terminal, output.deliveryManifest.accessible]
timeout: 4h
retry: {maxAttempts: 3, idempotencyKey: "${instance.id}:${contentItem.id}:produce"}
next: [review]
```

## STAGE review｜人工审核与交付

### Goal

在 Workboard 同一张视频任务卡中查看策划、Brief、成片、工程和 QC，批准、退回修改或拒绝。

```stage
actor: human
scope: content-item
needs: [produce]
approval: {actions: [approve, request-changes, reject], evidenceRequired: true}
outputs: [approvedAssetVersion]
timeout: 3d
next: [publish-feedback]
```

## STAGE publish-feedback｜发布与反馈

### Goal

对已批准版本按授权范围幂等发布、回收真实链接与数据，并形成下一轮建议；等待统计属于本阶段子状态。

```stage
actor: agent
scope: content-item
skills: [lark-base, social-search-apify-first, geelark-cloud-phone]
needs: [review]
sideEffects: [external-publication]
approval: {before: external-publication, scope: asset-and-account}
outputs: [publishTask, publicUrl, publicationEvidence, metricsSnapshot, retrospective]
completeWhen: [output.publicUrl.reachable, output.publicationEvidence.accountMatches, output.metricsSnapshot.traceableOrUnknown, output.retrospective.evidenceLinked]
timeout: 7d
retry: {maxAttempts: 4, idempotencyKey: "${instance.id}:${contentItem.id}:publish-feedback"}
```
