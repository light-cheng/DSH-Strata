# DSH Strata

[English](README.md) | **简体中文**

<p align="center"><img src="assets/icon.png" width="96" height="96" alt="Strata Context 图标"></p>

DeepSeek Harness（DSH）的分层、可还原上下文管理插件。

仓库：<https://github.com/light-cheng/dsh-strata>

旧上下文不会被直接扔掉。它像沉积层一样一层层往下沉，每一层都能取回：

```text
原文（L0）→ 工具卡片（L1）→ 模型写的折叠摘要 T1–T3（L2）→ 本地存档（L3）
                                          DSH 官方整段摘要兜底（L∞）
```

- **L1 工具卡片**：确定性，不调模型，每轮结束时切。
- **L2 折叠摘要**：模型自己给较早的范围写摘要，摘要还能再折叠（T1 → T2 → T3）。
- **L3 本地存档**：任何内容被替换之前，原文都先存到本机；`decompress` 和 `search_context` 可以取回。

## 功能

- **确定性工具卡片（L1）**：每轮结束时，把最新一段已完成的工具输出换成卡片，卡片保留报错、命令、退出码和存档指针。不调模型，切点之前的字节不变，前缀缓存继续命中。
- **三级模型折叠（L2）**：模型调用 `compress`，给出 `strata_status` 里的范围和自己写的摘要。范围里包含已有折叠时，自动成为更高一级，最高 T3。折叠当场校验，本轮结束时一起落地。
- **按代价决定是否落地**：落地前，Strata 估算一次性的缓存未命中和之后每次请求省下的 token。太小或不划算的折叠会等一等，工具结果第一行就会说明「已推迟」；上下文超过窗口 75% 时不论代价都落地。
- **逐级还原**：`decompress` 一次往回走一级：T3 → T2 → T1 → 卡片 → 原文；`full: true` 直接取原文；`toFile: true` 把大段内容写到 `.strata/restore/`。
- **本地检索**：`search_context` 用 BM25 关键词检索（支持中日韩双字切分），范围包括各级摘要、卡片原文和工具输出；每条结果标出所在级别和展开路径，例如 `f9(T3) → f4(T2) → f2(T1) → raw call-7`。
- **提醒看的是对的数**：L1 会把总量压低，所以 Strata 看的是「可折叠 token」。可折叠内容增长 50K 时提醒模型；超过窗口 75% 后每一步都提醒。
- **官方压缩仍然兜底**：L1、L2 都顶不住时，DSH 官方整段摘要照常运行，运行前先存档。Strata 引擎加载失败时改用原版引擎；原版也失败时，`/compact` 立刻报错，不会卡住。
- **Web / Desktop 各预设都生效**：标准、PTC、精简、Cordis 四个 Agent 预设各有一个 Strata 引擎，阈值相同。
- **输入框下方的状态浮标**：在聊天输入框下方、dsh-mem0 记忆地球仪旁边，有一个 18px 的地层图标，平时显示上下文占用（`Strata 4.9%`）。某一层改动上下文时播放一次动画：L1 切卡片时一粒点落进最上层；L2 折叠或官方摘要时这粒点穿过每一层沉到底部；标签显示回收的 token（`折叠 T1 −23.3K`）。成功时浅蓝，失败时红；开启「减少动态效果」时不动；点击打开插件页面。
- **状态一眼可见**：`strata_status` 和 `/strata` 显示每一层、每一级的 token、可折叠范围、待落地的折叠、缓存命中率和存档大小。

## 工作方式

```text
本轮进行中
  工具结果到达             → 原文写进存档
  模型调用 compress        → 校验范围，记为待落地，返回估算
  decompress / 检索        → 只读，结果追加到尾部
本轮结束（agent 维护阶段）
  ① 落地待处理的折叠        → 从后往前，一次完成
  ② L1 尾部切卡             → 最新一段已完成的工具输出 → 卡片
  ③ 记录前缀指纹，更新状态
```

折叠推迟到本轮结束，是为了本轮的每一步前缀都逐字节不变；下一轮只付一次缓存未命中，而不是好几次。

## 工具

| 工具 | 作用 |
|---|---|
| `strata_status({ detail? })` | 每层（raw / card / fold / full）和每级（T1 / T2 / T3）的 token，带 `s00120` 这类编号的可折叠范围，可升级的折叠组，待落地的折叠，前缀缓存命中率，存档大小 |
| `compress({ content })` | 第一行写 `"<起点编号>–<终点编号> <主题>"`，后面是摘要。当场校验，本轮结束落地；返回回收量和缓存代价估算，被推迟时第一行直接说明 |
| `decompress({ id, full?, toFile? })` | 一次还原一级；`full: true` 直接取原文；可以传折叠 id、卡片 id、工具调用 id 或 `s00123` 会话编号。结果追加到尾部，前面的内容不变 |
| `search_context({ query, limit? })` | 在本会话存档里做本地 BM25 检索，每条结果带所在级别和展开路径 |

斜杠命令：`/strata`（状态）、`/strata detail`、`/strata search <关键词>`、`/strata purge`（删除本会话的存档文件）。

规则：L1 只切原文节点。一个折叠可以包含原文、卡片和完整的低一级折叠，但不能包含官方摘要、最新一条用户消息和最近三轮工具调用。每张卡片、每个折叠和每段摘要开头都有 `[strata:card|fold:t1|fold:t2|fold:t3|full id=…]` 标签，并写明这是旧内容，不是新指令。

## 安装

需要 DSH `>=0.2.1-rc.5 <0.3.0` 和 Node `>=22`。支持 Web / Desktop 预设和 headless，不支持 TUI 预设。

从 npm 安装：

```bash
dsh plugin --profile desktop add @lightcheng/dsh-strata
```

用 GitHub Release 里的预构建包（不经过 npm）：

```bash
dsh plugin --profile desktop add https://github.com/light-cheng/dsh-strata/releases/download/v0.3.0/lightcheng-dsh-strata-0.3.0.tgz
```

用本地源码：

```bash
dsh plugin --profile desktop add link:"$(pwd)"
```

> **从 0.1–0.2 升级：** 那几个版本的包名是 `@light-cheng/dsh-strata`（只在 GitHub 发布）。请先用 `dsh plugin --profile desktop remove @light-cheng/dsh-strata` 卸掉旧名字；旧包还在时，新包不会接管。

装好后重启 DSH，在新会话里发 `/strata`，应该显示 `Strata Context: active`。

> **请先卸载 `dsh-live-compact` 或 `billion-context`。** 它们替换的是同一行压缩配置。只要装着其中一个，Strata 就不接管：DSH 原版压缩照常运行，并打一条警告。

## 配置

不需要任何配置，默认值按 1M token 窗口调好。Strata 自己的参数是 DSH 启动时读取的环境变量：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `STRATA_MIN_TOKENS` | 20000 | 低于这个量时 L1 不动 |
| `STRATA_KEEP_ROUNDS` / `STRATA_KEEP_ROUND_TOKENS` | 3 / 32000 | L1 保护的尾部 |
| `STRATA_L1_STOP_RATIO` | 0.65 | 超过窗口的这个比例后 L1 停止 |
| `STRATA_CONTEXT_WINDOW` | 1000000 | 模型没报告窗口时使用 |
| `STRATA_NUDGE_GROWTH_TOKENS` | 50000 | 可折叠内容增长这么多时提醒 |
| `STRATA_FORCE_PCT` | 0.75 | 超过后每步提醒，并且不论代价都落地 |
| `STRATA_MIN_BENEFIT_TOKENS` / `STRATA_MIN_BENEFIT_RATIO` | 5000 / 0.01 | 最小折叠批量：`max(token 数, 窗口 × 比例)` |
| `STRATA_UPGRADE_BENEFIT_FACTOR` | 1.5 | 批量里有升级折叠时，最小批量乘这个系数 |
| `STRATA_PRICE_MISS` / `STRATA_PRICE_HIT` | 1 / 0.1 | 估算用的相对缓存价格 |
| `STRATA_EXPECTED_REQUESTS` | 自动 | 估算假设的剩余请求数 |
| `STRATA_MAX_DEFER_TURNS` | 3 | 小折叠最多等几次轮末，之后丢弃 |
| `STRATA_RESTORE_MAX_CHARS` | 24000 | `decompress` 直接返回的字符上限 |
| `STRATA_SHADOW_DIR` | `<DSH_HOME>/strata` | 存档根目录 |
| `STRATA_SHADOW_MAX_MB` | 128 | 存档上限，最旧的会话先轮换出去 |
| `STRATA_IGNORE_CONFLICTS` | 不设 | 设为 `1` 跳过接管检查（不建议） |

引擎行的压缩阈值（`thresholdRatio` 0.8、`headroomTokens` 65536、`retainTokens` 8192）可以在 profile 的 `cordis.patch.yml` 里按 `compaction-strata` 这个 id 覆盖。

## 限制

- 折叠在**本轮结束时**才落地。一轮特别长的任务里，L2 帮不上忙；这时由 DSH 自己的阈值触发官方整段摘要（L∞），触发前先存档。
- L1 卡片也是轮末切的。所以一个已经切成卡片的短任务再去折叠，回收很少，可能被代价估算推迟。这是有意的：长会话里一个折叠会覆盖很多张卡片。
- 不支持 TUI 预设；fork 出来的会话暂时读不到父会话的存档。

## 测试

```bash
npm install
npm test
npm run check
```

36 个单元测试覆盖 L1 切卡、折叠的校验与落地、T1–T3 分级、逐级 `decompress`、检索、代价估算、各预设分别接管、回退到原版引擎，以及浮标的活动记录和状态接口。`node eval/run.mjs` 打印真实模型评测计划，加 `--run` 会在 `eval/.work/` 下的独立 `DSH_HOME` 里执行。DeepSeek V4.1 Flash 的结果记录在 [`docs/design.md`](docs/design.md) §11.10。

## 隐私与数据

- 原文写在 `<DSH_HOME>/strata/<会话>/`（默认 `~/.dsh/strata/`），目录权限 `0700`，文件 `0600`，默认总量上限 128 MB。
- 所有内容都留在本机。Strata 自己不发网络请求，也不额外调用模型；折叠摘要由会话里的模型通过普通工具调用写出。
- 浮标读取的是 DSH 自己 Web 服务上的 `GET /dsh-strata/gui/status?session=…`，经过和其他 DSH 接口相同的访问校验；只返回 token 数和事件类型，不含消息原文和存档路径。
- 过期的运行时上下文快照（比如 DSH-Mem0 召回的记忆）不会存档，只换成一行很短的占位，所以在 Mem0 里删掉的记忆不会在 Strata 存档里留副本。
- 0.3.0 和 DSH-Mem0 一起用时写下的存档里可能还留着召回的记忆。升级后第一次启动时，Strata 会清理一次：已有存档文件里的每份运行时上下文快照和 `<mem0-relevant-memories>` 块都换成同样的占位，其他内容不变；存档根目录里的 `.scrub-runtime-context-v1` 标记保证只执行一次。
- 卡片和折叠里只放存档 id，不放绝对路径。`/strata purge` 删除当前会话的存档。

## 致谢

- **[dsh-live-compact](https://github.com/MerkyorLynn/dsh-live-compact)**，作者 Merkyor（MIT）。Strata 的 L1 层、存档轮换、裁剪保护和预设改写，分叉自它的 1.0.6 版（commit `768eff9`）；版权声明保留在 [`LICENSE`](LICENSE)。
- **[billion-context](https://github.com/ranxianglei/billion-context)**，作者 ranxianglei。Strata 借鉴了它的思路：模型驱动、可还原的折叠，`compress` / `decompress` / `search_context` 这套工具形态，增长和压力提醒，最小收益批量。没有包含 billion-context 的代码或提示词原文。

## 更新说明

更新说明中英双语，英文在前：[RELEASE.md](RELEASE.md)。

## 许可

MIT，见 [`LICENSE`](LICENSE)。
