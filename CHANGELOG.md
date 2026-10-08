# Changelog

最新的在上面。2026-10-02 之前的记录在 `vegekyd-sys/v-openclaw-platform` 的 CHANGELOG.md。

- #4 fix(needs-you): 「需要你」只推人能做的事，卡片第一行写要你做什么；agent 没要求人做事的停卡由系统自己接着做（每条每步最多 2 次，最多自动多付 1 次钱）；按钮统一为「继续 / 这条不做了 / 暂停项目」
- #5 feat(notifications): 完成卡片可以带 Workflow 声明的链接（交付网页）
- #1 fix(nightshiftctl): 不再在 stderr 打印 SQLite ExperimentalWarning，解析输出不用再加 2>/dev/null
- 2026-10-02 从 v-openclaw-platform 拆出为独立仓库；新增 `docs/change-flow.md`、`scripts/ship.sh`、`scripts/manage-nightshift-vlab.sh`
