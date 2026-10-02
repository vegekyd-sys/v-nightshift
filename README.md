# v-nightshift

夜班模式：在 V 上、挨着 OpenClaw Gateway 运行的工作流引擎、Live Board 看板和交付页。

2026-10-02 从 `vegekyd-sys/v-openclaw-platform` 拆出，保留了全部提交历史，此后单独更新。夜班和 OpenClaw 之间唯一的接口是 Gateway RPC（原生 Workboard）。

## 怎么改

**先读 [docs/change-flow.md](docs/change-flow.md)。** V 和 Claude Code 用同一套流程：开工 → 复现 → 改和测试 → VLab 候选测试 → PR → 合入 → 共享 VLab 验收 → 上线 V → 验收 → 记录。

```sh
npm ci
npm test                          # 引擎、看板服务、交付页
npm run dashboard:build           # 构建看板和交付页
scripts/ship.sh vlab <commit>     # 部署到共享 VLab（只装不启动）
scripts/ship.sh v <commit>        # 部署到 V（只重启夜班），并把共享 VLab 对齐
```

## 目录

| 路径 | 内容 |
|---|---|
| `packages/nightshift-core` | 引擎：workflow 编译、调度、卡片、交接、失败处理、Gateway 重启处理 |
| `apps/nightshift-dashboard` | Live Board 服务和页面，交付页（`delivery/`） |
| `scripts/nightshiftctl.mjs` | 操作命令行（V 上是 `nightshiftctl`） |
| `scripts/ship.sh` | 打包并部署一个已合入的提交 |
| `scripts/manage-nightshift-production.sh` | V 上的部署、回滚（root） |
| `scripts/manage-nightshift-vlab.sh` | 共享 VLab 上的部署、启停、暂停项目、回滚（root） |
| `systemd/` | 服务单元 |
| `examples/` | workflow 和项目示例 |
| `lab/candidate/` | VLab 候选测试的 plan 和场景 |
| `docs/` | 流程、运维手册、设计文档 |

## 相关仓库

- `vegekyd-sys/v-openclaw-platform`：OpenClaw 本体发版、V 主机运维、VLab 工具（`lab/vlab.mjs`）、给原生 Workboard 打的补丁。
- `vegekyd-sys/v-core`：V 的 skill，包括 `night-shift-operator`。
