# Changelog

最新的在上面。2026-10-02 之前的记录在 `vegekyd-sys/v-openclaw-platform` 的 CHANGELOG.md。

- #4 fix(needs-you): 停卡卡片按付费台账写清有没有扣费、外部任务号、失败还是没过验收；新增「重做这一条」（新修订号、新付费操作），不再给出会死循环的「重新执行」；卡片指令要求 agent 停下时先写中文四行报告
- #1 fix(nightshiftctl): 不再在 stderr 打印 SQLite ExperimentalWarning，解析输出不用再加 2>/dev/null
- 2026-10-02 从 v-openclaw-platform 拆出为独立仓库；新增 `docs/change-flow.md`、`scripts/ship.sh`、`scripts/manage-nightshift-vlab.sh`
