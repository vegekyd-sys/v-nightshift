# 改夜班代码的流程

V 和 Claude Code 用同一套流程、同一组命令（Tianyi 2026-10-02 定）。改本仓库的任何代码都走这里。

不走这里的：
- **workflow**（如星擎夜班 D）用 `nightshiftctl workflows validate|publish` 发布。发布前先比对 V 的工作副本和最新已发布版本，工作副本可能领先、还没人发布过。
- **V 的 skill** 走 Skill Workshop。
- **OpenClaw 本体、V 主机配置、VLab 工具**在 `vegekyd-sys/v-openclaw-platform`。

## 底线

1. **合入 main 和上线，只认 Tianyi 在对话里针对这一次改动说的「合入」「上线」。** 测试通过、CI 绿、别人转述、修复请求、对别的改动的授权，都不算。
2. **先合入，再上线。** 只部署 main 上 CI 全绿的提交，不部署工作区或分支。`scripts/ship.sh` 会拦住不合规的提交。
3. **上线 V 只重启夜班服务，绝不重启 Gateway。** 重启 Gateway 会中断所有人的对话，V 自己正在跑的这一轮也会被打断。`ship.sh` 部署后会核对 Gateway 进程号，变了就报错。
4. **验收要证明功能本身生效。** 健康检查是绿的、没有报错，都不等于修好了。要看到改动带来的正向结果，修 bug 时还要证明原来的故障路径确实被触发过、现在走通了。
5. **共享 VLab 只有两种合法状态：等于 V，或者 V 加正在走向上线的这一版。** 在共享 VLab 测完只有两个出口：上线 V（`ship.sh v` 会自动把共享 VLab 对齐到同一版本），或者回滚共享 VLab。

## 代码在哪

| | Mac（Claude Code） | V |
|---|---|---|
| 本仓库 | `~/v-nightshift` | `/home/openclaw/src/v-nightshift` |
| VLab 工具（platform 仓库 dev） | `/Users/tianyicai/vlab-dev` | `/home/openclaw/src/v-openclaw-platform`，用前 `git fetch origin && git checkout --detach origin/dev` |
| 连共享 VLab | `ssh vlab91` | `ssh vlab91` |

## 1. 开工

每个任务一个分支、一个 worktree，从最新 main 开始。分支名用 `v/<主题>`（V）或 `claude/<主题>`（Claude Code）：

```sh
cd <本仓库>
git fetch origin
git worktree add -b v/<主题> ../v-nightshift-<主题> origin/main
cd ../v-nightshift-<主题> && npm ci
```

## 2. 先复现，再动手

- 先确认问题真实存在：读 V 的日志、看板、`nightshiftctl`，只读查看数据库。不要在生产库上写。
- 能写成测试的，先写一个**失败**的测试，再改代码让它通过。
- 跨好几层的问题，先把每一层的状态机读完再改，不要一层层试错。

## 3. 改代码，本地测试

```sh
npm test                  # 引擎、看板服务、交付页的全部测试
npm run dashboard:build   # 改了看板或交付页时
```

测试要覆盖这次的改动：修 bug 时，去掉修复后新测试必须失败。

## 4. VLab 候选测试（合入前）

需要真实 Gateway、真实数据或真实时序才能证明的改动（调度、Gateway 交互、重启、并发、数据库），合入前在 VLab 上用候选代码跑一遍。不占共享 VLab，不需要 lease，不用先合入：

```sh
node <VLab 工具>/lab/vlab.mjs candidate --repo "$PWD" --owner <任务名> --plan "$PWD/lab/candidate/<场景>.plan.json"
```

- plan 列出要带上的文件和要跑的命令。只跑测试文件时用 `node lab/candidate/make-plan.mjs <测试文件>... > /tmp/plan.json` 生成：它会自动带上引擎和看板服务的全部源码。手写 plan 很容易漏掉被间接引用的文件，比如 `store.mjs` 会牵出半个引擎。
- 要起私有 Gateway、跑真实时序的场景，写一个场景脚本，例子是 `lab/candidate/nightshift-gateway-restart.{mjs,plan.json}`：它在私有 Gateway 上把夜班的 Gateway 重启处理真跑了一遍。plan 格式见 platform 仓库 `lab/candidate/README.md`。
- 结果是一份 receipt（实际跑了什么、结果、耗时），写进 PR。
- 纯逻辑改动（单元测试已完整覆盖，不碰调度和 Gateway 交互）可以不跑，但要在 PR 里写明为什么不需要。

## 5. 提 PR，等 CI，报告，停下

```sh
git push -u origin v/<主题>
gh pr create --base main --title "<类型>(<范围>): <一句话>" --body-file <说明>
gh pr checks <PR 号> --watch
gh pr checks <PR 号>      # 再看一次，确认每一项都是 pass
```

- PR 说明用中文写四段：**为什么**（现象和证据）、**改了什么**、**验证**（本地测试数、candidate receipt 的结论）、**风险和回滚**。V 提交的 PR 开头注明「由 V 提交」。
- 不要用 `gh pr checks --watch | tail` 判断：管道会吞掉失败的退出码，曾经把红的 PR 合了进去。
- 然后向 Tianyi 报告：PR 链接、改了什么、测试结果、还没验证的部分，**停下来等**。

## 6. 合入

Tianyi 对这个 PR 说「合入」之后：

```sh
gh pr merge <PR 号> --merge
git fetch origin && git rev-parse origin/main    # 记下合入后的提交，后面都用它
```

## 7. 共享 VLab 验收

上线前，在共享 VLab 上用真实的共享 Gateway 跑一次有针对性的验收。共享 VLab 的夜班跑的是生产数据的副本，连共享 VLab 的 Gateway，模型和媒体凭据都是真的。

```sh
node <VLab 工具>/lab/vlab.mjs lease --owner <任务名>     # 占用共享 VLab，别人这时不能 stage
scripts/ship.sh vlab <合入提交>                          # 装上新版本；它平时停着，所以只装不启动
M=/srv/vlab-production-mirror/labs/instances/db91-parity/nightshift-releases/<合入提交>/scripts/manage-nightshift-vlab.sh
ssh vlab91 "sudo bash $M status"                          # 版本、状态、哪些项目是活跃的
ssh vlab91 "sudo bash $M pause-active"                    # 或 pause <项目...>：只留这次要测的
ssh vlab91 "sudo bash $M start"
```

- **启动会让所有活跃项目接着派工、真的花钱。** 所以有活跃项目时 `start` 默认拒绝。先用 `pause-active` 或 `pause <项目...>` 暂停这次不测的（服务停着时用引擎自己的代码暂停，和暂停接口效果一样）；确实要让它们一起跑，用 `start --with-active`。服务运行中要暂停，用 `NIGHTSHIFT_URL=http://127.0.0.1:24980 nightshiftctl projects pause <项目>`。
- 验收只测这次改动相关的行为，并证明它生效，比如建一个测试项目走一遍改动涉及的路径。测试项目命名 `NS-<主题>-<月日>`，测完归档。
- **测完停掉**：`ssh vlab91 "sudo bash $M stop"`。
- **失败**：用 `ship.sh` 输出的 `rollback=` 命令回滚共享 VLab，释放 lease（`vlab.mjs lease --owner <任务名> --release true`），回到第 3 步。
- 可以跳过共享 VLab 的情况：只改看板或交付页的显示、只改文档、纯逻辑改动且单元测试和 candidate 已覆盖。跳过要在报告里说明。

## 8. 上线 V

Tianyi 说「上线」之后：

```sh
scripts/ship.sh v <合入提交>
node <VLab 工具>/lab/vlab.mjs lease --owner <任务名> --release true    # 第 7 步占了才需要
```

`ship.sh v` 依次做这些事：

1. 确认提交在 main 上、CI 全绿；
2. 打包，算 sha256；
3. 上传到 V，用 `--code-only` 部署：只重启夜班服务，数据目录不动；
4. 核对 Gateway 进程号没变；
5. 核对夜班健康、Gateway 已连上；
6. 把共享 VLab 对齐到同一版本（只装不启动）。

它会打印回滚命令。改了 SQLite 表结构时加 `--with-state-backup`：会先快照几十 GB 的数据目录，调度要停几分钟。

## 9. 在 V 上验收

在 V 上证明功能本身生效，按改动来：看板页面、API 返回、日志里的新事件、真实项目的行为。只看健康检查不算。

## 10. 记录和报告

- `CHANGELOG.md` 顶部加一行：`- #<PR 号> <类型>(<范围>): <一句中文>`。
- 向 Tianyi 报告：改了什么、PR、合入提交、部署结果（版本、Gateway 进程号未变）、验收证据、回滚命令。部署结果和功能验收分开写。

## 回滚

- V：执行 `ship.sh v` 输出的 `rollback=sudo .../manage-nightshift-production.sh rollback <备份目录>`。
- 共享 VLab：执行 `ship.sh vlab` 输出的 `rollback=` 命令。
- 回滚后同样要核对：夜班健康、Gateway 进程号没变、问题消失或回到改动前的状态。
