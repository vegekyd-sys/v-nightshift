# Changelog

最新的在上面。2026-10-02 之前的记录在 `vegekyd-sys/v-openclaw-platform` 的 CHANGELOG.md。

- #14 fix(dashboard): 项目卡的时间分开显示排队和干活：没开工显示「提交 · 排队中」，开工后从第一张卡真正开始算「已进行」并另写排队时长，已交付的用时只算干活时间
- #13 perf(delivery): 大视频按四路分段下载，校验范围、版本和长度；不支持时回退完整下载，保持原画质
- #12 fix(scheduler): 正常轮次不再从 action ledger 重新读入已完成卡；保留审批、所有 blocked 恢复和完整 repair，不降低夜班并发或派工速率
- #11 feat(storage): 已完成 14 天的项目每天 05:00 自动删除中间媒体（保留成片、handoff/交付清单引用的文件和所有记录，硬链接副本不删），每个项目留清理台账；10/14 上线首轮清掉 61 个项目 14612 个文件、数据盘 82%→73%
- #9 feat(dashboard): Workflow 页默认显示「在产总览」：所有在产的线一屏看全（每条线的状态和在产项目、汇总的需要你），点线进入原来的泳道，点项目直达
- #8 fix(brief): 付费外部调用超过 60 分钟没结果就停下交给夜班处理，不再一等几个小时；服务方要求确认 brief 已定的方案时直接在同一项目确认
- #7 fix(dashboard): 被新尝试取代的旧卡不再显示成「自愈中」、不占进度，projects monitor 也不再算作 blocked（DL-1009-02 已交付却显示 19/24、自愈中 5）
- #6 fix(needs-you): 夜班重启后，已开着的「需要你」请求能正常改写成新文案（#4 上线后 V 上 4 条没改写）；自动处理次数用完的停卡当轮就开请求，不再多等一轮巡检（约 5 分钟）
- #4 fix(needs-you): 「需要你」只推人能做的事，卡片第一行写要你做什么；agent 没要求人做事的停卡由系统自己接着做（每条每步最多 2 次，最多自动多付 1 次钱）；按钮统一为「继续 / 这条不做了 / 暂停项目」
- #5 feat(notifications): 完成卡片可以带 Workflow 声明的链接（交付网页）
- #1 fix(nightshiftctl): 不再在 stderr 打印 SQLite ExperimentalWarning，解析输出不用再加 2>/dev/null
- 2026-10-02 从 v-openclaw-platform 拆出为独立仓库；新增 `docs/change-flow.md`、`scripts/ship.sh`、`scripts/manage-nightshift-vlab.sh`
