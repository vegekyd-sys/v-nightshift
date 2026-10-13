---
apiVersion: nightshift.versa.ai/v1alpha1
kind: Workflow
metadata:
  id: xingqing-night-f
  version: 0.1.0
  name: 星擎夜班 F（测试专用，其他人勿用）
spec:
  # 项目完成后发飞书卡片：发起人记录在项目上就发给发起人，没记录时兜底发到同事群
  notifications:
    instanceCompleted: {enabled: true, to: "oc_1a87e2b3b3295d233017732f50dd8e6a", link: {label: 打开交付网页, stage: deliver-page, output: deliveryPage}}
  ownerAgentRole: content-operator
  requiredCommands: [scene, makaron-cli, lark-cli, ffprobe]
  concurrency: {perInstance: 1}
  completion: {mode: strict-v1}
  handoff: {version: 1, mode: stage-input-output}
  contentItems:
    routes: [AI_GENERATE, SCENE_EDIT]
    maxItems: 7
    source: output.contentItemsManifest
  inputs:
    planningDocUrl: {type: string, required: true}
    enterpriseName: {type: string, required: true}
    targetCount: {type: number, required: true}
    damProjectId: {type: string, required: true}
    authorizationScope:
      type: object
      required: true
      requiredProperties: [paidProduction, externalPublication]
    deliveryMode: {type: string, enum: [download], default: download}
    routePlan: {type: object, required: false}
    testScope:
      type: object
      required: true
      requiredProperties: [requirementRecordId, serviceRecordId, accountRecordId, productionCount, publishCount, reserveCount, workdays]
    publicationTarget:
      type: object
      required: false
      requiredProperties: [accountRecordId, tiktokHandle, geelarkDeviceId, platform, market, language, timezone]
---

# 星擎夜班 F（测试专用，其他人勿用）

本工作流只做测试制作和交付页，不提交发布任务、不写成片 Buffer 池。用户在交付页确认之后，由独立入池排期任务写池，现有 GeeLark 流程到点发布。

测试项目每家仅绑定一个 accountRecordId；targetCount=7，testScope.productionCount=7、publishCount=5、reserveCount=2、workdays=5。账号及服务资格来自项目输入指定的真实记录，不能因另一企业或同名旧合同的状态而放行。两个企业分别建实例，机器 ID 用 F-日期-序号，展示名明确“F测试”、企业、市场语言。

客户、账号与策划案读取现有 Base。下载交付仍可使用现有交付表，但必须按本 F 实例的交付链接匹配记录，不能按企业名覆盖 D/E 既有交付记录；成片和清单使用本 F 实例独立目录与对象名。

**交接单硬要求（全阶段，只此一处定义）**：每个阶段结束前**必须**把本阶段交接单落盘（v1 形状）；**未落盘 = 完成校验驳回、整卡 blocked**（报 `Stage handoff is required: <stage>`）。**落盘位置（0.3.9 依实盘 DL-0914-03 / DL-0914-04 固化）**：`scope: project` 的阶段 → 实例根 `handoffs/<stageId>.json`；`scope: content-item` 的阶段 → `content-items/<contentItem.id>/handoffs/<stageId>.json`。各阶段正文只写“本阶段 `inputs` 填什么”，不再重复本规则。

**上传**：需要把 V 上的文件（本地改过的成片、交付清单）放到公开地址时，统一用 `cdn-upload` 技能（目前传 Makaron CDN，bucket `images`，公开域 `cdn.makaron.app`）；Makaron 自己出的成片直接用 Makaron 链接，不重复上传。不手搓 curl、不另写上传脚本。

## STAGE plan-route｜策划读取 + 任务拆分 + 逐条路线判断

### Goal

先核对 testScope：本项目只覆盖指定企业与一个账号，targetCount 必须等于 7，制作/排期/库存/工作日数必须为 7/5/2/5。用 Base 实时读取指定策划案需求行、账号行，以及原运营表 IVlxbfPwqa9cjPsNzhucpS3rnPH/tblbmcjTL3aD1EUG 的 serviceRecordId：策划案可读、企业/市场/语言匹配、账号已登录且有云机、指定合同在服务期中才拆任务；缺项停住说明原因。同名合同不能取第一行猜。把核实的记录和数量写进 requirement-snapshot.json，每个 ContentItem 都带 publicationTarget 的 market、language；weeklyPublishCount=5 是后续入池任务的额度，不在本阶段排期。

读取策划案，按运营给的 `targetCount` 拆成独立 ContentItem，并逐条判路线（`AI_GENERATE` / `SCENE_EDIT`）。项目输入里有 `routePlan`（如 `{"AI_GENERATE": 5, "SCENE_EDIT": 5}`）就按它的条数分配路线；没有就遵守策划案的比例（纯 AI 不少于 20%）。素材缺失不是第三条路线。

**拆条目之前，先判断素材够不够（这一步不花钱，后面的出片花钱）**：用 `scene agent` / `scene search` 看这家企业在 Scene 里有多少段**不同的**视频素材（只看 Scene 返回的计划和元数据，不下载素材）。一段不同的视频素材最多撑 5 条混剪：`SCENE_EDIT` 条数 > 不同视频素材数 × 5，就是素材不够。素材不够时**不要照样拆满 `targetCount` 条**，停下来 block 本卡，按停工报告格式写清楚：

```
问题：素材撑不起 <N> 条混剪
原因：<企业> 在 Scene 里只有 <X> 段不同的视频素材、<Y> 张图
影响：照样做会在出片时失败，或者 <N> 条内容高度雷同
建议：补素材后重新执行；或者减少条数；或者改成以 AI_GENERATE 为主（需要运营确认）
```

输出四个文件：`requirement-snapshot.json`（读到的需求事实，含 `traceable: true`、`planReadable: true`）、`content-items.json`（`items[]`，**每条自带 `id`、`title`、`route`、`status: "planned"`**——引擎只按条目上的 `route` 派下一步；再加 `durationSeconds`：策划案对这条成片写了时长就填，并在 `durationSource` 引原文；**没写就填 `null`，不要自己定**）、`route-decision.json`（每条的路线、理由、约束）、以及策划案链接。

```stage
actor: agent
scope: project
skills: [lark-base, lark-doc, lark-shared, max-qijian-planning-doc, scene-cli, material-verification]
outputs: [requirementSnapshot, planUrl, contentItemsManifest, routeDecision]
completeWhen: [output.requirementSnapshot.traceable, output.requirementSnapshot.planReadable, output.contentItemsManifest.hasAtLeastOneItem, output.contentItemsManifest.everyItemHasStableIdAndTitle, output.routeDecision.everyItemHasRoute, output.routeDecision.evidenceLinked, output.routeDecision.constraintsExplicit]
timeout: 1h
retry: {maxAttempts: 2, idempotencyKey: "${instance.id}:plan-route:${input.hash}"}
next: [brief]
```

## STAGE brief｜备料 + Brief 编译

### Goal

**一个节点干完两件事：备料（检索 / 验真 / 冻结可追溯生产输入）→ 编译 brief（当前视频唯一、可执行、不可变的 FinishedVideoBrief）。** 拆成两个节点会制造一个"想要更对口的素材却改不动"的交接，所以合在这里。

**节点内部顺序由对应 skill 决定**（`ai-video-brief` / `remix-video-brief`），本文件不重复。

**缺素材时换文案或换角度**（用素材库里现有镜头重新选题或改写脚本），**不等人补拍**。

**产物文件名固定 `finishedVideoBrief.md`（.md 不是 .json），与引擎 deliverables 的 `proposal.summaryPath` 对齐；文件末尾必须独立两行 `inputsFrozen: true` 和 `productionReady: true`。**

**交接单**：`inputs` 填 plan-route 的产物（requirementSnapshot / planUrl / contentItemsManifest / routeDecision）；落盘位置见顶部。

```stage
actor: agent
scope: content-item
routeStrategies:
  AI_GENERATE:
    skills: [ai-video-brief, scene-cli, material-verification]
    description: 按 ai-video-brief 写一页纸 15 秒 brief（一句话创意、产品事实、1–3 张参考图、红线），产出 materialReadiness.json、frozenInputManifest.json、finishedVideoBrief.md。镜头拆分交给 Makaron。 成片规格统一9:16、1080×1920，写入本条brief，语言与本项目publicationTarget一致。
  SCENE_EDIT:
    skills: [remix-video-brief, scene-cli, material-verification]
    description: 按 remix-video-brief 用一次 scene agent 要一份 9:16 素材计划（时长用本条 durationSeconds；为 null 就按选题和素材定，不默认 15 秒），冻结成 frozenInputManifest.json，再写一页纸 finishedVideoBrief.md 和 materialReadiness.json。口播、节奏、BGM 交给 Makaron。 成片规格统一9:16、1080×1920，写入本条brief，语言与本项目publicationTarget一致。
needs: [plan-route]
outputs: [materialReadiness, frozenInputManifest, finishedVideoBrief]
completeWhen: [output.frozenInputManifest.accessible, output.frozenInputManifest.routeFit, output.frozenInputManifest.sourcesTraceable, output.finishedVideoBrief.routeMatchesContentItem, output.finishedVideoBrief.inputsFrozen, output.finishedVideoBrief.productionReady]
timeout: 7d
retry: {maxAttempts: 2, idempotencyKey: "${instance.id}:${contentItem.id}:brief:${input.hash}"}
next: [produce]
```

## STAGE produce｜出片

### Goal

把本条已冻结的 `finishedVideoBrief.md` 交给 Makaron 出片，等结果，下载成 `produce/final.mp4`。本阶段声明付费副作用，付费调用按引擎注入的外部操作登记流程留痕；项目输入里 `authorizationScope.paidProduction: true` 即为授权，不再逐条人工审批。本阶段不写任何 Base 表（仅由 `deliver-page` 写本 F 实例的交付记录）。

`makaron-cli chat` 返回的 runId 先落盘 `produce/run-state.json` 再等结果；续跑时先读它，已有 runId 就只查结果、不重新提交付费生成。

```stage
actor: agent
scope: content-item
routeStrategies:
  AI_GENERATE:
    skills: [makaron]
    description: 用 makaron skill 把本条 finishedVideoBrief.md 原文交给 Makaron 出片，等到结果，下载为 produce/final.mp4。一条视频只产出一次付费生成：Makaron 先回文案要求确认时，在同一个项目里回复确认让它继续出片（确认轮不花钱，不算新的提交）；确实拿不到视频再 block 本卡写明原因，不新开项目、不自行重做。 请求并取得1080×1920的原画成片，不用fast_720p导出件；交付前用ffprobe实际核实宽高，能免费重导就重导，不重新付费生成。
  SCENE_EDIT:
    skills: [makaron]
    description: 用 makaron skill 把 frozenInputManifest.json 作为 media manifest、本条 finishedVideoBrief.md 原文作为消息交给 Makaron 出片，等到结果，下载为 produce/final.mp4。一条视频只产出一次付费生成：Makaron 先回文案要求确认时，在同一个项目里回复确认让它继续出片（确认轮不花钱，不算新的提交）；确实拿不到视频再 block 本卡写明原因，不新开项目、不自行重做。 请求并取得1080×1920的原画成片，不用fast_720p导出件；交付前用ffprobe实际核实宽高，能免费重导就重导，不重新付费生成。
needs: [brief]
sideEffects: [paid-production]
approval: {before: paid-production, scope: content-item}
outputs: [finishedAsset]
completeWhen: [output.finishedAsset.newForThisRun]
timeout: 4h
retry: {maxAttempts: 3, idempotencyKey: "${instance.id}:${contentItem.id}:produce"}
next: [deliver-page]
```

## STAGE deliver-page｜交付网页

### Goal

仅当 `deliveryMode=download` 时执行：等待全部 ContentItem（被跳过的除外）完成生产，做一个**交付网页**给同事验收、也可以直接转给客户——每条视频在线播放、可单条下载、可「下载全部」（在看的人自己的浏览器里打包）。**不打 zip、不把视频下载到 V。** 然后幂等回写飞书 Base 交付表「星擎夜班｜下载交付」（app token `MOYqbvbt5amKPesStYEcRIrxnTb`，table id `tbl9rzwNlVkS5U7G`）：字段固定 `企业名称`（link 客户总览表 `tblnoTpNnHgF9XTB`——先按企业名称查到 record id，写 link 值，不写字符串）、`企业发起时间`、`本次批次条数`、`交付时间`、`下载链接`（**交付网页地址**）；运营字段是 lookup，不手写。不得创建逐条人工审核、外部发布审批或 GeeLark 发布任务。

**做法**：
1. **逐条定链接**：对每条未被跳过的 ContentItem，取它已验收的成片 `produce/final.mp4`（以 produce 交接单为准）。Makaron 出片时返回的视频链接（在 produce 的结果、`finishedAsset.json` 或外部操作记录里）若存在，对它发 HEAD：`content-length` 与成片大小**一致**就直接用这个 Makaron 链接；**不一致或没有链接**（本地加过 BGM、剪辑、重编码，或是临时地址）就用 `cdn-upload` 技能上传成片：`--prefix nightshift/<instanceId>/videos`，用它返回的 `url`。
2. **写交付清单** `deliver-page/manifest.json`：
   `{"version":1,"title":"<企业 语种 N条>","archiveName":"<按命名规范>.zip","deliveredAt":"<ISO 时间>","items":[{"id":"<contentItem.id>","title":"<选题标题>","url":"<上一步的链接>","fileName":"<按命名规范>.mp4","bytes":<成片字节数>,"durationSec":<时长>}]}`
   清单顶层补 `review`={"enabled":true,"sourceProjectId":instanceId}（只对F启用）、`batchId`=instanceId、`enterpriseName`、`market`、`language`、`testScope`（只含非敏感记录标识与数量）；每条 `id` 必须来自 `content-items.json`，供后续确认任务关联，不能重新编号。条目顺序按 `content-items.json`；`title`（网页标题）写给人看：`<企业> <语种> <N>条`；条目 `title` 用选题原文；`fileName`、`archiveName` 按下面的命名规范。
3. **上传清单**：用 `cdn-upload` 技能，`--key nightshift/<instanceId>/deliver/manifest.json --content-type application/json`（固定对象名：重新发布时链接不变）。
4. **交付网页地址** = `https://nightshift.tianyi.live/deliver/?m=` + 清单 url（整个 url 做 URL 编码）。打开一次确认能看到全部条目。
5. 拿到网页地址**先写 Base 交付表**（`下载链接` = 网页地址），再落盘 `deliver-page/delivery-page.json`（`{"published":true,"url":"<网页地址>","manifest":"<清单 url>","items":N}`）与 `deliver-page/base-delivery-receipt.json`（`{"recorded":true,…}`），写 handoff、complete。

**可续跑**：链接已定、已上传的条目不重复上传（技能按内容去重）；清单覆盖同一个对象名，网页地址不变；Base 交付表仅按本项目交付链接精确定位；已有本 F 实例的行才更新，没有就新建，不能仅凭企业名或“最近一行”覆盖 D/E 记录；中途遇到后台短暂不可用要重试而不是放弃。

命名规范（康浩源 2026-09-30 定）：**用途标识放最前**（`DL`=下载件 / `TK`=TikTok 发布件，一眼区分用途）；**企业名称与语言必须进文件名**；**唯一性只靠最后的短后缀**（取 contentItemId 或 8 位短哈希）——**不得用前缀承担防重名**。
- 每条视频 `fileName`：`{用途标识} {企业名称} {语言} {标题} {唯一后缀}.mp4`——**不带日期**（控长度，Windows 解压后全路径上限 260）。
- 打包名 `archiveName`（「下载全部」得到的 zip）：`{用途标识} {发起日期} {企业名称} {语言} {N条} {唯一后缀}.zip`；`{N条}` 写清单里实际的条数。`{发起日期}` 取企业发起日期，CST、写 `YYYY-MM-DD`（要更细用 `YYYYMMDD-HHMM`）——**不得写 `HH:MM:SS`**。

**文件名安全化（强制，企业名称、语言、标题逐个过一遍）**：出现 `? : * " < > | / \` 或控制字符时，一律替换成全角 `？ ： ＊ ＂ ＜ ＞ ｜ ／ ＼`（或删除），**不得原样写进清单**。半角 `?` `:` 是 Windows 非法字符，系统自带解压器与多数手机解压器会**不报错、直接跳过该条目**——2026-09-29 `DL-0929-02`（天易成韩语 20 条）只解出 6 条即此因。

上传只用 `cdn-upload` 技能，不手搓 curl、不另写脚本。

**交接单**：`inputs` 填 produce 的产物 `finishedAsset`；落盘位置见顶部。

**完成判据**：逐条核对 `content-items.json`——每条未被跳过的 ContentItem 都必须已有 `finishedAsset`；未齐则继续等待（本阶段是 project scope，用有界轮询，不用 stage 依赖）。

```stage
actor: agent
scope: project
skills: [lark-base, lark-shared, background-worker-contract, cdn-upload]
needs: [produce]
when: {input: deliveryMode, equals: download}
sideEffects: [external-delivery]
resourceLock: "delivery:${instance.id}"
outputs: [deliveryPage, baseDeliveryReceipt]
outputContracts:
  deliveryPage: {type: json, equals: {published: true}}
  baseDeliveryReceipt: {type: json, equals: {recorded: true}}
completeWhen: [output.deliveryPage.published, output.baseDeliveryReceipt.recorded]
timeout: 1h
retry: {maxAttempts: 3, idempotencyKey: "${instance.id}:deliver-page:${input.hash}"}
```
