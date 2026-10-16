# 正常调度不重复读取已完成卡

本修复保留夜班并发、启动速率和完整功能。它减少正常调度轮次的重复 Workboard 读取，尚未证明真实 12 个夜班任务下的前台端到端目标通过。

## 回归与修复

`a9ef86dff44a06ca8b76665f731f36744b6cc760`（2026-09-17）让正常轮次跳过本地已终态的 run。`dcaeed85ad2abe47a8c37a4fc32cc2c20ec5d684`（09-18）为了防止审批卡重复创建，把 action ledger 加入读取范围；但 runtime 已把普通 run 卡也写入该 ledger，于是已完成卡被重新加入，原过滤失效。活跃项目积累的已完成卡越多，每次正常调度重复读取的历史越多。

现在 run 对应的卡只从 run 的筛选结果进入正常读取；ledger 继续补充没有 run 的卡，包括审批卡。只有本地 `done/cancelled` run 跳过正常读。所有 `blocked` 保留，因为即使没有 `automaticRetry` 标记，也可能等待产物、付费操作恢复或人工处理。`review/ready/scheduled/running` 继续读取。原生 done 卡尚未通过完成校验时，本地 run 保持 running，因此不被跳过。每五分钟的 repair 仍读取全部卡。

审批的原生幂等键、claim/Attempt、父子依赖、执行/取消/重试方法、并发上限和派工速率均未改动。

## 同一冻结输入的三版本比较

输入是 V 活跃项目的一份只读事务 inventory，以及同一批卡的另一份 Workboard 只读事务导出。两次抽取之间生产继续运行，inventory 有 124 个 done，稍后的 native 行有 126 个 done；它们不是跨数据库原子快照。三版本测试共用相同冻结字节，不能混用这两个计数。此前另一时点的 236 卡快照不参与下表。

- 21 个 active 项目，181 个 run，181 条 ledger，原生 181 张卡；inventory 非终态 57 张，native 非终态 55 张，全部保留。
- 1,934 个 event、142 个 attempt、523 个 artifact、370 个 comment。定向 JSON 3,887,439 bytes，源 Workboard 只读导出耗时 27 ms；未复制 Agent 大库。
- 输入 SHA256：`f39af417fefea3df82a04cc0947ea49e00e91b2e418b4275b80bf1bd2ba0d3c8`。
- native SQLite 模块 `sqlite-store-CH-caj1l.js` SHA256：`9043747801b1f3e590f8194da6bb33e41322abc36f32ace8abad07f87a5149a0`。
- 使用候选 runtime 的真实 `WorkboardSqliteCardStore.lookup`，每版 12 轮、交替顺序。首轮单列；其后 11 轮为热缓存样本。首次调用受 JIT、顺序和已写入数据页影响，不宣称为严格冷缓存实验。

| 版本 | 每轮 native lookup | 材料化输出 bytes | 首轮 ms | 热缓存 median ms | 热缓存 P95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 09-17 过滤版 `a9ef86d` | 57 | 538,629 | 7.759 | 6.742 | 8.445 |
| 生产 `8426f85700970cd4610b25be64d3ab12b9eaaff1` | 181 | 2,691,544 | 164.135 | 35.250 | 47.341 |
| 本修复 | 57 | 538,629 | 63.241 | 7.165 | 9.308 |

热缓存中位耗时约减少 79.7%，读取卡数减少 68.5%，材料化输出减少约 80.0%。较早的一轮完整预热后独立重复测试为生产 35.730 ms、修复 5.821 ms；不把预热样本与首次调用混合报告。

修复与 09-17 版本的输出卡 ID 集合 SHA256 相同：`f42f1fa8c7f99b1750f932d218333f800915463fb86a18a0c9dd67ee33ba28ef`；材料化输出 SHA256 均为 `f0ef75ad297127a421a319d2f19719e4dfe06c6d6fc441518bd64e5f2b312d85`。所有版本 repair 集合均为 181 张，native 卡行前后哈希相同。

VLab receipt：`candidate-e7328a98-e9aa-4a43-b610-c5942f4e7630`，runtime SHA256 `a6c6592f14fdb2a7f8830d612d56ca4fe6ee07aa0dae71eae9017ff60616d1dc`，共享 Gateway PID 734198 前后相同。原始数据和 receipts 保留在本机私有协调目录，不提交仓库。

可复用入口为 `lab/candidate/nightshift-scheduler-scope.mjs`。环境参数 `NS_SCOPE_SNAPSHOT` 指定私有定向 JSON（可 gzip），`NS_SCOPE_SEPTEMBER17/NS_SCOPE_PRODUCTION` 指定从对应 Git commit 导出的 scheduler 模块。按 `docs/change-flow.md` 使用官方 candidate，所有数据库构建与读取均在其私有目录内完成，不修改共享实例。

## 正确性与尚待验收

新增回归先在旧代码上失败，证明 ledger 会重新引入 done/cancelled。测试保留无 run 审批、所有 blocked 恢复、automaticRetry、native done 等待完成校验、跨项目预算和 repair 全量读取。完整本地测试 422 项：419 通过、3 个原有 skip。

本基准测量 SQLite lookup 和材料化，不含完整 Gateway RPC 的会话 hydration、模型执行或真实前台会话；它不能把几十毫秒的机制收益解释为所有秒级卡顿的根治。

完整验收仍须在相同真实 12 个夜班任务、相同数据库历史、模型和父子结构下，对比前台 dispatcher→runStart、runStart→首正文、receive→visible/end、夜班完成吞吐，以及逐卡无丢失/重复和终态释放。由协调会话串行安排共享 VLab，独立记录夜班与 OpenClaw 版本；本补丁没有生产上线或共享占用动作。

回滚使用夜班仓库的 `scripts/ship.sh` 与发布回执的 rollback 命令，只回滚夜班代码并核对 Gateway PID。代码修复不涉及 schema 或数据迁移。
