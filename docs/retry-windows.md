# Retry 是新尝试窗口，不是重新申请业务授权

需先确认 `health.workflowFeatures.retryWindows = 1`。使用已有 `cards retry` 或 `decisions decide … --option continue`，没有独立的时间授权命令或新审批按钮。

```sh
nightshiftctl cards retry <原停止卡ID> --actor V --note '在已有授权内修正并继续'
```

若本卡拥有明确失败的外部操作且需新调用，沿用已有 `--allow-new-operation`；这是执行方表达“本次 retry 会产生新操作”的参数，不要求再次找用户点预算确认。仍须处于任务原有有效授权范围内。

## 窗口随 retry 重置

一次有效 retry 为它所在的调用路径重新计时：截止时间为 `retry 时刻 + 声明的尝试时长`，调用时长使用 `min(stage.timeout, repeat.maxDuration)`。非根子执行自己声明的时长也从这次 retry 计时。原父子执行、控制卡和循环轮次不重建；后续业务轮次继承当前窗口，不在每轮偷偷重新计时。

- 已超时 held 在 `duration-limit`，或还未投影为 held 的过期调用，都可由正常 retry 恢复。
- 原子卡 blocked 时沿正常恢复；子卡仍 ready/scheduled 而调用已过期时，也可 retry 原卡重置调用窗口，保留原生定时执行约束。正在运行或完成的卡重复 retry 不会凭空创建一次新执行。
- 同一 native attempt 的重复请求、重启重放不会持续后移 deadline；真正再次执行失败后的 retry 可再取得完整窗口，不限“只能加时一次”。尚未重新执行但又过期的排队窗口也可正常再 retry。
- 根项目已声明的总时长仍是项目边界，不从 retry 重置。嵌套调用的窗口逐层限制，不能通过子调用取得比其父路径更长的窗口。其他独立名额不会被重做或顺便解除 hold。

## 操作额度随新尝试接续，总账不清空

retry / continue 已明确接受一个已知失败阶段的新尝试时，首次 `operations reserve` 会自动绑定这张最新卡、原失败回执、请求 hash 和操作键，沿用现有事务及防重机制提供一次尝试所需的卡专用额度。**正常 retry 后不需要再调用 `operations authorize-recovery`。** 既有手工兼容入口仍保留，但不是新流程的必经步骤。

同卡修复回执、读取已有任务或继续在途任务，保持原订单/操作键，不再登记另一个操作；真正的新尝试才使用新的操作身份。失败原记录、费用、旧资源和回执全部保留，仍计入项目累计操作数；项目总操作上限、金额授权和循环轮数不清零。次数也不等于现金预算，执行方仍需核算实际费用及承诺支出。

自动额度不可转借给其他卡、阶段或请求；一个原失败最多有一个紧邻后继操作。当前回执改为非 failed、绑定 hash 改变、原额度为零、根总额度耗尽，仍拒绝新 reserve。没有新 retry 的循环结果不获得额外额度。

## 哪些不是 retry 能消除的状态

暂停、自动派工关闭、原阶段被禁用或跳过、被较新轮次/修订取代、迭代上限和其他业务 hold 不能借重置时间清除。reserved 或 unknown，及没有可回读任务 ID 的 executing 操作，先读回原供应商结果；不能创建另一张卡重复下单。已知 executing 且明确指向本卡原任务时可接续，保留原 key/task，不重提。

限流、外部准入、凭据暴露等业务事实也不会因 retry 变成通过。相关修复由 V 在已有权限内推进，不把技术窗口耗尽当成需要用户另批“时间授权”。

## 审计、兼容及验收

子流程已完成、控制卡因输出停住时，显式 retry 会重新读取原子执行的导出，不再永久使用旧结果缓存。重新读取必须再次通过原导出阶段的执行证据、操作回执、handoff 与完成契约，不能用历史 `stage.completion.validated` 事件批准修改后的文件。缺失、损坏或不满足契约的产物仍停住；不会创建新子执行、清除失败或提交外部操作。已经成功退出的调用保留已消费的结果快照，不因重复 retry 或原文件后来改变而重放下游。

布尔业务结论可用现有 `outputContracts.equals` 明确要求 `true`。裸 `completeWhen` 保持历史存在性／真值语义（旧流程也会检查时间字符串），不全局改写旧声明或发布 SHA。动态资源引用仍需由业务阶段实际回读、核归属并向下游传递；机械校验通过不代表外部资源或账号已验收。

`stage.retry.window-reset` 审计事件记录原卡、native attempt、目标阶段尝试、原/新 deadline、重置代次和操作来源；使用现有 audit 表，无 schema 变更。调用摘要提供 `attemptWindowStartedAt / retryWindowId / deadline`。新卡首次 reserve 的卡绑定额度继续使用 `external-operation.recovery-authorized` 审计事实；它由正常 retry 路径自动生成，并不代表新增用户预算授权。

候选 `lab/candidate/retry-window-http-scenario.mjs` 用私有 Gateway、真实 Workboard 和正式 HTTP API，验证真实超时→普通 retry→自动恢复尝试额度→成功出口；不调用时间或操作授权接口。原生远期卡阻止 Agent 启动，供应商回执全部合成，零外呼。单元回归覆盖 blocked 及排队卡、重复请求、SQLite 重开、多次重试、原任务接续、预算/暂停/未知结果和正常旧流程兼容。

`lab/candidate/retry-export-http-scenario.mjs` 追加验证原导出修复、旧校验事件不放过错误新产物、原子执行复用和成功快照不重开。该场景同样明确零 Agent／供应商调用，不能替代真实 Agent→业务验证→交付的 VLab 实机验收。

测试通过不表示生产已部署或真实业务已完成。PR #30 原先的独立时间授权设计已撤除，不存在 `calls authorize-time-recovery` 或其 API。
