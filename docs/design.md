# dsh-strata 设计草案

状态：草案 v0（2026-11-04），只有设计，还没有实现代码。
目标：做一个 DeepSeek Harness（DSH）上下文插件，合并 dsh-live-compact 和 billion-context 的优点。上下文分层往下沉，需要时可以取回。

> **名字冲突**：npm 上的 `dsh-strata` 已被别人占用（`jsdvjx/dsh-strata`，作者 ccfly-creator，0.12.1，是一个 DSH Web GUI 的滚动条/会话地图插件，2026-08 创建）。包名必须另定，见 §9 的 D1。

---

## 0. 调研依据

| 来源 | 版本 / 提交 | 读了什么 |
|---|---|---|
| dsh-live-compact | 1.0.6，`768eff9`（2026-11-04） | `shell.js` `index.js` `gate.js` `plan.js` `shadow.js` `thunder.js` `cordis.patch.yml` README |
| billion-context | 0.1.212，`23a826d`（2026-11-04） | README、CLIENTS.md（dsh 部分）、TECHNICAL-NOTES、CONFIGURATION、`src/agent/dsh-native.ts` 头部、`dsh-compaction-*.ts`、`kernel/src/compress-tools.ts`、`dsh.bundle.patch.yml`、LICENSE |
| DSH 本机 | Desktop 0.2.1-rc.5（从 `app.asar` 读出） | `@deepseek-ai/dsh-compaction`、`dsh-compaction-basic`、`dsh-session` |
| 兄弟项目 | `../DSH-Mem0` 0.2.3、`../dsh-web-search-tavily` 0.1.0 | 插件结构、patch 写法、发布清单 |

### 0.1 对任务描述的核对

| 原描述 | 结论 |
|---|---|
| live-compact：超过约 20K 后每轮修剪，不调模型 | ✅ `SPINE_MIN_TOKENS` 默认 20000；在 `agent/status → idle` 且本轮已完成时切 |
| 约 74ms，模型摘要 14.5s | ⚠️ 74ms 是 20 题长链路里 **20 刀的总耗时**，模型摘要 14.552s 是原版那次单次摘要。另一场 150 题是 145 刀共 2.2s，约 15ms 一刀 |
| 前缀保持不变 | ✅ 更准确地说：切的是**最新一段已结束的内容**（保护区之前的尾段），切点之前的字节不变 |
| shadow 在 `~/.dsh/compaction-spine/shadow`，上限 128MB | ✅ 按会话分子目录，权限 0700/0600，可用 `SPINE_SHADOW_MAX_BYTES` 改 |
| 保留报错和最近 3 轮工具调用 | ✅ `KEEP_ROUNDS=3`，另有 `KEEP_ROUND_TOKENS=32000` 上限；报错优先进卡片 |
| 官方大压缩的触发线 650K 不变 | ❌ 650K（`BIG_GATE`）是 live-compact **自己停止小切**的线。官方大压缩仍按 `thresholdRatio: 0.8` + `headroomTokens: 65536` 触发，由它继承的 `BasicCompactionEngine` 执行 |
| TUI 下不能用 | ✅ TUI 预设里的原版压缩换不掉 |
| billion-context 注入 4 个工具 | ✅ `compress` `decompress` `search_context` `acp_status`，另有只读的 `acp_cache` |
| `/acp`、`/acp-cache` | ✅ DSH 插件注册了这两个命令 |
| 前缀缓存命中目标 95–97% | ✅ README 原文就是这个数 |
| `bili dsh` 会关掉自动压缩 | ✅ 主平面 `compaction-basic` 设 `auto:false`；Web 预设在加载时禁用，`/compact` 在 Web profile 里也不能用 |
| 代理没有认证 | ✅ 只靠 loopback 和家目录文件权限，没有按会话的授权；多用户机器上不安全 |
| 启动上下文大时要到约 200K 才压缩 | ✅ 第一次压缩在「启动内容 + 50K」（`nudgeGrowthTokens`）。启动约 100K 时会到约 200K |
| 早期阶段 | ✅ README：“Early … Expect rough edges.” |
| MIT 加署名条款 | ✅ 见 §8 |

**任务描述里没写、但影响设计的事实：**

1. **两者工作在不同的层。**
   - live-compact 在 DSH **会话层**：它是 `ctx.compaction` 的提供者（继承 `BasicCompactionEngine`），用 `surfaceOp: replace` 把一段历史换成一条 checkpoint 消息。
   - billion-context 在**网络层**：插件起一个本地代理，改写 `globalThis.fetch`，把模型请求转到 `<proxy>/bili/<url>`。压缩在请求体上做，DSH 自己的会话日志一直是原文，压缩状态存在代理自己的目录里（`~/.local/share/billion-context/`）。
2. **两者抢同一个位置。** live-compact 要占 `ctx.compaction` 并禁用 `compaction-basic`。billion-context 要把 `compaction-basic` 设成 `auto:false`，并用 `internal/config` 把 Web 预设里的压缩行全部禁用。两个同时装，结果取决于加载顺序，而且 billion-context 会把 live-compact 的引擎行一起关掉。**不能共存，只能选一个当主人。**
3. **DSH 的 surface 只有两种操作：`append` 和 `replace`**（一段区间换成一个事件）。没有「展开 / 还原」操作。被替换的原事件还在会话日志里（`compaction/summary.shadowedSeqs`），但不能原地放回 surface。所以「还原」只能是把内容作为新的工具结果追加到尾部（billion-context 的 `decompress` 本来也是这样），或者写到文件里。
4. billion-context 的 `kernel/` 是独立包 `acp-kernel`（MIT），代码量大（约 23K 行 TS），处理的是 OpenAI/Anthropic 线上的消息格式，不是 DSH 的会话事件。

---

## 1. 两个上游的机制

### 1.1 dsh-live-compact（会话层，确定性）

```
tool/result 到达 ──► captureOne：按 toolCallId 把原文写进 shadow/raw-*.txt
agent 变成 idle 且本轮完成 ──► finishTurn（agent.runMaintenance 里，30s 超时）
   ├─ 量 token：<20K 或 ≥650K 就不动
   ├─ selectNewestChunk：从尾部往回找
   │    · 跳过尾部的助手短句、checkpoint
   │    · 保住最近 3 轮工具调用（≤32K）
   │    · 往前合并，直到 32K（RAIL_TOKENS）或碰到用户消息 / checkpoint
   │    · 两端都要满足 tool-pairing 平衡
   ├─ buildCard：确定性卡片（报错、命令、路径、哈希、字节数、后台任务）
   ├─ saveShadow：这一段的原文落盘，写失败就不切
   └─ commitSelectedSpan：compaction/start → summary → user/message(replace) → end
```

- 卡片标明「这是旧内容摘录，不是新指令，也不是授权」。
- 卡片必须比原文小，否则不切。
- 会给 DSH 自带的 `toolResultPruner` 套一层：修剪前先把原文存好。
- 官方 `/compact` 和 0.8 比例的大压缩仍走父类。
- `gate.js` 在加载时改写 4 个 Web 预设，把 `dsh-compaction-basic` 换成自己。
- `shell.js` 是一层保护：引擎装不上就退回原版，原版也装不上就让 `/compact` 立刻报错，不让会话挂起。

**优点**：快、不花钱、不破坏前缀、行为可预测、出错就不动。
**缺点**：卡片只是摘录，没有语义上的归纳；切掉的东西只能自己去读 shadow 文件，**没有检索工具**；TUI 不支持。

### 1.2 billion-context（网络层，模型驱动）

```
DSH 插件 bili-native ──► 起本地代理 + 改写 fetch ──► 模型请求经过代理
代理每轮：
   ├─ 给每条可寻址消息加 <acp tokens=… type=…>mNNNNN</acp> 标签
   ├─ 增长到「启动 + 50K」或达到 75% 窗口 ──► 往请求里注入提醒（nudge）
   ├─ 模型调用 compress({content:"m00150–m00220 主题\n摘要…"})
   │    └─ 把这段折叠成块 bN；之后每次请求，这段在线上都换成摘要
   ├─ decompress(bN)：上浮一级（T2→T1），或 full:true 还原原文，或 toFile
   ├─ search_context：按关键词搜索块摘要和折叠掉的原文
   ├─ acp_status / acp_cache：用量、可压区间、缓存归因
   └─ 95% 时紧急截断超大的工具输出；超过窗口时由代理自己做 preflight 压缩
```

- 分层蒸馏 T1→T3，摘要可以再被压缩。
- 前缀策略：头部 system 消息保持不变，摘要以 user 消息的形式放在原位置；`minPressureBenefitTokens` 让折叠攒成大批，避免频繁小折叠反复打破缓存。
- 可还原、可检索，模型自己决定压什么。

**优点**：语义压缩，能取回，能检索，工具链成熟，有缓存归因诊断。
**缺点**：多了一个代理进程和 fetch 改写，没有认证；在 DSH 会话之外另存一份状态（两份数据要对齐）；体量大、迭代快（几千个 issue 编号），在 DSH 上有已知坑（#1158 某些传输层的请求根本不经过代理）；Web profile 里 `/compact` 被关掉；项目自称早期。

---

## 2. 合并后的分层架构

**基本取舍：做成纯 DSH 进程内插件，不用代理。** 所有层都通过 DSH 的会话 surface 实现，原文以 DSH 会话日志和本地存档为准。

理由：
- 没有未认证的本地端口，不改写 fetch；
- 只有一份状态（DSH 会话日志 + 本插件存档），和 DSH 的持久化、fork、导出天然一致；
- live-compact 已经证明这条路在 DSH 上可行，代码小（约 3K 行），MIT。

```
            新 ◄──────────────────────────────────────────────── 旧
surface:  [system] … [L2 折叠摘要] [L1 卡片] [L1 卡片] … [L0 原文：保护区]
                          │            │                      │
                          ▼            ▼                      ▼
L3 本地存档：  fold-*.json          cut-*.txt / raw-*.txt    （每个 tool/result 到达时就落盘）
              + DSH 会话日志里的 shadowedSeqs（原事件永远在）
              + 检索索引（search_context）
```

| 层 | 内容 | 谁触发 | 调模型 | 能还原 |
|---|---|---|---|---|
| **L0 原文** | 最近 N 轮工具调用 + 当前用户消息之后的内容 | — | — | — |
| **L1 卡片** | 工具输出卡片（live-compact 那种） | 插件，每轮结束 | 否 | 是，从 L3 读原文 |
| **L2 折叠摘要** | 模型写的范围摘要，可以覆盖多张 L1 卡片 | 模型调用 `compress`，插件提醒 | 是（模型自己写，不额外调用） | 是，`decompress` 取回上一层或原文 |
| **L3 本地存档** | 所有被替换内容的原文 + 元数据 | 每次 L1/L2 落地前先写 | 否 | 就是来源 |
| **L∞ 兜底** | DSH 官方整段摘要 | 只在 L1、L2 都没顶住时 | 是 | 是，存档仍在 |

### 2.1 节点标签与「不重复压缩」规则

每个 checkpoint 消息带一个 stratum 标记（放在 `source` 或内容开头的固定标签里）：`raw | card | fold | full`。

1. L1 只切 `raw` 节点，遇到 `card/fold/full` 就停（live-compact 已经这样处理 checkpoint）。
2. L2 的折叠范围可以包含 `raw` 和 `card`，**不能和已有的 `fold` 部分重叠**。想再压一层 fold，要显式做成更高一级（MVP 要实现）：
   - 一个 fold 带级别 `tier`：只包含 raw/card 的是 T1；包含至少一个完整 T(n) fold 的是 T(n+1)，MVP 支持到 T3；
   - 高一级 fold 必须**完整**包住下级 fold，不能切开下级 fold；它可以同时包住相邻的 raw/card；
   - 级别标签写进 stratum 标记（`fold:t1` / `fold:t2` / `fold:t3`）。
3. 每个 fold 的存档记录它直接包含的子节点（下级 fold、卡片、原文 seq）和它们的存档指针（路径、哈希），所以 `decompress` 可以一级一级往回走：T3 → T2 → T1 → 卡片 → 原文。
4. L∞ 官方整段摘要之前先把整段存档，再把存档索引写进摘要。

### 2.2 一轮里的时序

```
turn 进行中：
  tool/result 到达 → 原文立刻写进 L3（raw-<toolCallId>）
  模型调用 compress(...) → 校验范围 → 记成「待落地」，工具返回 “已接受，本轮结束时生效 + 预计回收 X token”
  模型调用 decompress / search_context → 只读，结果追加到尾部
turn 结束（agent idle，在 runMaintenance 里）：
  ① 先落地待处理的 L2 折叠（按位置从后往前，一次 flush）
  ② 再做 L1 尾部小切
  ③ 记录前缀指纹，更新 status
```

**为什么 compress 要推迟到本轮结束**：本轮之内前缀不动，缓存在本轮的多步之间一直命中；所有改动集中在一次维护里，下一轮只付一次未命中的代价。

---

## 3. 触发阈值（默认值，都可配置）

| 名称 | 默认 | 来源 | 说明 |
|---|---|---|---|
| `l1.minTokens` | 20K | live-compact | 低于这个不切 |
| `l1.keepRounds` / `l1.keepRoundTokens` | 3 / 32K | live-compact | 保护区 |
| `l1.chunkMax` | 32K | live-compact | 一刀最多切多少 |
| `l1.stopTokens` | 窗口 × 0.65 | live-compact（650K 固定值）改成按比例 | 超过后 L1 停，让位给 L2 / L∞。待定，见 Q3 |
| `l2.nudgeGrowthTokens` | 50K | billion-context | L1 之后的「可折叠量」比上次折叠多出这么多时提醒模型 |
| `l2.forcePct` | 75% | billion-context | 超过后每轮都提醒 |
| `l2.minBenefitTokens` | max(5K, 窗口 × 1%) | billion-context | 回收量太小的折叠不落地，攒批 |
| `emergencyPct` | 95% | billion-context | 截断超大工具输出（原文已在 L3） |
| `full.thresholdRatio` | 0.8 + headroom 65536 | DSH 原版 | L∞ 兜底 |

**注意**：L1 让「总 token」一直被压得比较低，所以 L2 不能看总量，只能看「可折叠量」（保护区以外的 raw + card），否则 L1 一直在工作，L2 永远不会被提醒。这是两套机制配合的关键。

---

## 4. 前缀缓存策略

DeepSeek 的缓存按前缀命中。规则只有一句：**改动点越靠后，代价越小；改动越少，代价越小。**

1. **头部不动**：system 和工具定义保持字节不变。插件的说明用 `ctx.systemPrompt.section` 一次性注册，内容固定，不放动态数字（动态状态放到 `acp_status` 的结果里）。
2. **L1 只切尾部**：只有切点之后的内容需要重新计费，这部分本来就短。
3. **L2 折叠前沿单调往后**：新的 fold 尽量从上一个 fold 的末尾之后开始。L2 落地时，从 fold 起点往后的内容都会未命中一次，所以：
   - 落地前估算代价 `未命中 token × 单价` 和收益 `回收 token × 预计剩余轮数 × 命中单价`，收益不够就推迟；
   - 同一轮的多个 fold 一起落地；
   - 把这个估算写进 compress 的返回结果，让模型知道代价。
   - 升级（T1→T2→T3）发生在更靠前的位置，未命中的代价更大，所以升级的最小收益门槛要高于普通 T1 折叠（默认 ×1.5，参考 billion-context 的分级阈值思路）。
4. **还原只追加**：`decompress` 的内容作为工具结果追加到尾部，不改中间（DSH 也不支持中间展开）。
5. **可观测**：`/strata` 命令显示每轮命中率、哪一层的哪次改动造成了未命中（参考 billion-context 的 `/acp-cache` 归因）。

---

## 5. 还原与检索

- **存档（L3）**：`<DSH_HOME>/strata/<session>/`
  - `raw-<toolCallId>.txt`：工具原文，在 `tool/result` 到达时写入（沿用 live-compact 的做法，也让 DSH 自带修剪器先等存档写好）；
  - `cut-*.txt`：L1 切掉的那一段（包括用户和助手的原话）；
  - `fold-<id>.json`：L2 的块，包括范围、摘要、吞掉的卡片指针、原事件 seq 列表；
  - 目录 0700、文件 0600、有总上限（默认 128MB，从最旧的会话开始轮换，当前会话不删）。
  - 会话日志里的 `shadowedSeqs` 是第二份来源：存档被删了，也能从 DSH 日志里取回原文。
- **工具**（参考 billion-context 的名字和语义，方便模型迁移）：
  - `compress({ content })`：同 billion-context 的单字符串格式，引用 id 用 DSH 的事件 seq，映射成短 id（如 `s01234`）；
  - `decompress({ id, full?, toFile? })`：默认往下展开一级（T3 → 它包含的 T2 摘要 + 相邻内容；T1 → 卡片和原话；卡片 → 原文）；`full:true` 直接还原原文；`toFile` → 写到工作区，只返回路径。返回内容里带下一级的 id，方便模型继续展开；
  - `search_context({ query, limit })`：MVP 用本地倒排 / BM25（纯 JS，无需外部服务），覆盖 L1 卡片、各级 L2 摘要、L3 原文；结果标明命中在哪一级，以及从当前 surface 节点展开到它的路径（如 `f9(T3) → f4(T2) → f2(T1) → card c17`）；
  - `strata_status()`：各层 token；L2 按 T1/T2/T3 分别显示块数和 token；可折叠区间（包括「可升级」的相邻 fold 组）；上次命中率。
- 卡片和摘要里不放本机绝对路径，只放存档内的相对 id（live-compact 1.0.3 的做法）。

---

## 6. 和 DSH 自带压缩的关系

| DSH 组件 | 处理 |
|---|---|
| `compaction-basic`（`ctx.compaction` 提供者） | **由本插件接管**：继承 `BasicCompactionEngine`，`cordis.patch.yml` 里把原行 `disabled: true`，插入自己的引擎（live-compact 的方式） |
| Web 预设（standard / ptc / minimal / cordis）里嵌套的压缩行 | 用 `internal/config` 在加载时把 `dsh-compaction-basic` 换成本插件（live-compact `gate.js`；billion-context 用的是按结构匹配，对自定义预设更稳，可以参考） |
| `toolResultPruner` | 保留，但修剪前先存档（live-compact `ensurePruneGuard`） |
| `/compact` | 保留：先存档，再做 L∞ 整段摘要 |
| TUI | MVP 不支持，检测到就不接管，日志说明 |
| 与 dsh-live-compact、billion-context 同时安装 | 启动时检测，发现就不接管并大声警告（两者都会去禁用 / 替换同一行） |

`shell.js` 那种保护层要保留：引擎装不上 → 退回原版；原版也装不上 → `/compact` 立刻报错，不让预设一直等待。

---

## 7. MVP 范围

**做：**
1. L3 存档 + L1 卡片：从 live-compact 1.0.6 分叉移植，换包名、目录、日志前缀，保留它的测试。
2. stratum 标签和「不重复压缩」规则。
3. `compress` / `decompress` / `strata_status` 三个工具，compress 推迟到本轮结束落地。
   **多级蒸馏 T1–T3**（§2.1 第 2、3 条）：fold 可以再被折叠成更高一级；`decompress` 一级一级往回展开，`full:true` 直接还原原文；`strata_status` 按级别显示 token。升级提醒和普通折叠共用 §3 的阈值：可升级的相邻 fold 组的 token 总量也算进「可折叠量」。
4. L2 提醒：可折叠量增长 50K、75% 强制。
5. `search_context`：本地关键词检索。
6. `/strata` 状态命令：各层 token、命中率。
7. headless 和 Web/Desktop profile；接管检测和退回原版。
8. 评测：重跑 live-compact 的「长填日志」和「失忆对比」两套，再加两套：「L2 折叠后用 decompress / search 找回细节」；「多级折叠（到 T3）后，用 decompress 逐级展开和 search_context 找回原文细节」。

**不做（之后再说）：**
- TUI；
- T3 以上的级别；
- 用模型做提醒时机判断（billion-context 的 `nudgeModelDecided`）；
- 向量检索；
- 设置页 / Web 客户端（DSH-Mem0 那种）；
- 图片 / 媒体内容的折叠。

---

## 8. 许可和署名

| 上游 | 许可 | 如果复用代码 |
|---|---|---|
| dsh-live-compact | MIT，© 2026 Merkyor | 保留版权声明和许可文本。计划分叉它，所以 `LICENSE` 里加上它的声明，README 里写明来源 |
| billion-context | MIT + **产品署名附加条款**，© 2026 ranxianglei | 只要用了它的代码（包括 `acp-kernel`），就要在首页、文档或「关于 / 致谢」中至少一处写明「使用了 billion-context」，附链接 `https://github.com/ranxianglei/billion-context`（用了 kernel 还要加 `https://github.com/ranxianglei/acp-kernel`） |
| acp-kernel | MIT（同上署名条款） | 同上 |
| deshark42/dsh-compaction-basic-disable | MIT | 只有在照搬它的 overlay 时才需要 |

建议：**只借鉴 billion-context 的思路和工具接口，不复制它的代码**（例如 compress 的提示词文本）。即使这样，README 也主动致谢两个上游。如果之后决定移植某段提示词或算法，就按附加条款在 README 的「致谢」中写明，并在文件头标注来源。

---

## 9. 需要用户拍板的决策

| # | 问题 | 选项 | 建议 |
|---|---|---|---|
| **D1** | 包名（`dsh-strata` 在 npm 已被别人的 DSH 插件占用） | a. `@light-cheng/dsh-strata`（scope）<br>b. 换名，如 `dsh-context-strata`、`dsh-strata-context`<br>c. 只用 GitHub tgz 发布，不上 npm | a：保留项目名，不撞包名；但 DSH 插件市场里同名会混淆，展示名可以叫 “Strata Context” |
| **D2** | 基础代码 | a. 分叉 live-compact，L2 自己写，只借鉴 billion-context 的思路（不用代理）<br>b. 分叉 billion-context<br>c. 全部从零写<br>d. 组合：直接依赖 billion-context，只加 L1 层 | a。b 体量太大，而且是代理架构；c 浪费 live-compact 已有的测试和边界处理；d 两个层互相打架（见 §0.1 第 2 条） |
| **D3** | compress 何时生效 | a. 本轮结束统一落地（缓存最好）<br>b. 下一步立刻生效（模型马上看到结果） | a |
| **D4** | 是否保留 DSH 官方整段摘要作为兜底 | 保留 / 去掉 | 保留，但先存档 |
| **D5** | 首个版本支持哪些 profile | headless + Web/Desktop / 只 headless | headless + Web/Desktop（你平时用 Desktop） |
| **D6** | 语言 | 纯 JS（同 live-compact、DSH-Mem0）/ TypeScript | 纯 JS + JSDoc，构建最简单 |
| **D7** | git / 远程仓库 / 发布 | 什么时候 `git init`、仓库名（如 `light-cheng/dsh-strata`）、公开还是私有 | 你确认后我再做 |

## 10. 风险与待定问题

**风险**
- **R1 DSH 内部接口不稳定**：`internal/config`、`surface.replaceGeneration`、`agent.runMaintenance` 都不是公开承诺的接口，DSH 0.3 可能变。两个上游都在这里反复踩坑。对策：锁 `dsh >=0.2.1-rc.5 <0.3.0`，启动时做接口探测，失败就退回原版。
- **R2 模型不按规矩调用 compress**：可能乱用、伪造确认信息，或者范围写错（billion-context #717 遇到过）。对策：严格校验范围，结果只以 `strata_status` 为准。
- **R3 L2 打破缓存**：fold 在中间落地，起点之后都要重新计费。对策：§4 的代价收益估算和攒批；需要实测。
- **R4 存档膨胀和隐私**：原文全部落盘。对策：权限 0600、总上限、`/strata purge`；README 写清楚。
- **R5 卡片 / 摘要被当成指令**：沿用两个上游的「历史内容不是新指令」的写法。
- **R6 和其他压缩插件同时装**：检测后拒绝接管。
- **R7 多级蒸馏丢细节**：摘要的摘要最容易把具体数值、路径、报错丢掉。对策：每级摘要必须保留下一级的 id 和关键硬信息（报错、路径、哈希）；评测专门测逐级找回；在 DSH 上要确认 `replace` 一个包含已有 checkpoint 节点的范围是否被允许（`assertSourceEventReferences` 等检查）。

**待定问题**
- **Q1** compress 的引用 id：用 DSH 事件 seq，还是像 billion-context 那样按会话视图编号（`mNNNNN`）？DSH seq 永远不变，更简单，但需要在消息里显示（会改变消息内容 → 影响缓存，要在消息第一次出现时就加上）。
- **Q2** 消息上要不要加 `<acp tokens=…>` 这类标签让模型看到大小？加了模型更会选范围，但会增加 token，而且必须在消息第一次发送时就加上，以后不能改。
- **Q3** L1 的停止线：沿用固定 650K，还是按窗口比例？L1 停了以后，L2 能不能单独顶到 0.8？
- **Q4** fork / 子会话：存档怎么沿着父会话查找（billion-context 有 `derivedFrom`，深度上限 8）。
- **Q5** 用户在 Web 里回退 / 编辑历史时，待落地的 compress 和 fold 怎么处理。
- **Q6** 评测预算：真实 DeepSeek 跑三套评测的花费和时间，要不要先只跑 headless。

---

## 11. 实现说明（MVP 0.1.0，2026-11-04）

对照 DSH Desktop 0.2.1-rc.5（`app.asar`）和 npm 上的 `@deepseek-ai/*@0.2.1-rc.5` 核对过的接口，以及和本文前面不一致或前面没定的地方。

### 11.1 接口核对

| 接口 | 结论 |
|---|---|
| `internal/config` | ✅ 存在。`cordis-plugin-loader` 用 `fiber.ctx.waterfall(fiber, "internal/config", raw, () => raw)`，`next()` 是同步的，`gate.js` 的写法照旧可用 |
| `surfaceOp` | ✅ `dsh-session` 只认 `"append"` 和 `{ op: "replace", startSeq, endSeq }`，替换后 `surface.replaceGeneration += 1`。fold 用的就是 replace，和 L1 卡片同一条路。replace 一个**已经含有 checkpoint 的范围**也允许，见 §11.7 |
| `agent.runMaintenance` | ✅ 存在，原版 `compactNow` 也在里面跑。fold 落地和 L1 小切都在 live-compact 原有的 `finishTurn` 这一次维护里完成（先 L2 后 L1） |
| 工具执行上下文 | ✅ `tool.execute(args, exec)`，`exec.agent.session` 可用 |
| 命令 | ✅ `ctx.commands.register({ definitionId, name, description, input?, handler })`，`handler(invocation)` 拿到 `invocation.agent` 和 `rawInput` |
| 提醒（nudge）通道 | ⚠️ 文档里没写怎么注入。实际用的是 `agent/pre-step` waterfall：在 `decision.messages` 末尾追加一条 `createUserMessage`（DSH 自己切换模型时就这样追加提示）。最初只在这一步本来就有新用户消息进入时追加；现在（22957eb 之后）任意步骤都可以追加，所以单轮很长的任务中途也会收到提醒。没理会的提醒在再增长 ½ 步长后重新出现，75% 以上为 ¼ 步长；连续两次没理会且超过 50%（或超过 60%）时，轮次结束时由 Strata 自己写抽取式自动摘要（`auto=1`，见 README「自动摘要」）。来源写成 `{ kind: "strata", form: "notice" }`，这个自定义 kind 没有在持久化校验里验证过，真机要看一眼 |
| 缓存命中 | ✅ `assistant/message` 事件的 `data.usage`：`inputTokens` 是未命中部分，`cacheReadTokens` 是命中部分 |
| 上下文窗口 | ✅ `session.requestHeader().config.{provider,model}` + `ctx.llm.resolveModelInfo(...).context.contextWindow`；拿不到时用 `STRATA_CONTEXT_WINDOW`（默认 1M） |
| cordis 可选依赖 | ⚠️ cordis 没有 optional inject。工具行必需 `tools` + `compaction`；`commands`、`systemPrompt` 用嵌套的 `ctx.inject([...])`，缺了也不影响工具 |
| 两个 compaction 提供者 | ⚠️ cordis 第二次 `provide("compaction")` 会抛 `service "compaction" has been registered at <…>`。live-compact 原来的 `releaseCompaction` 在构造失败后会删掉 store 里的 compaction，**可能删掉别的插件的**。Strata 在构造前先查 store，已有别人就让出（不 provide、不删），见 §11.3 |
| Config | ⚠️ 引擎的 `Config` 是原版的 zod schema，加字段不稳。Strata 自己的阈值全部用 `STRATA_*` 环境变量（和 live-compact 读 `SPINE_*` 一样），README 有表 |

### 11.2 待定问题的处理

- **Q1 引用 id**：用 DSH 事件 seq，显示成 `s00123`。**不往消息里加标签**（Q2 选「不加」）：模型通过 `strata_status` 看到可折叠区间的起止 ref（`detail:true` 列出每条），提醒消息里也带最大的三段。这样消息字节不变，不影响缓存。
- **Q3 L1 停止线**：改成按比例 `窗口 × STRATA_L1_STOP_RATIO`（默认 0.65）。L2 没有单独的停止线，75% 以上提醒按 ¼ 步长重新出现、并且无视代价直接落地；再往上交给 L∞（0.8 + headroom）。
- **Q4 fork / 子会话**：没做。存档只按当前 session id 找。
- **Q5 回退 / 编辑**：待落地的 fold 记的是 seq 列表；落地前逐个重新校验（节点还在、顺序不变、仍是 raw/card），变了就丢弃并记日志，不会落到错的位置。L1 这一刀如果和待落地的 fold 重叠，这一轮不切。
- **多级（T1–T3）**：已按 55b37db 的范围实现，见 §11.6。

### 11.3 接管检测

- 构造时：别的插件已经提供 `ctx.compaction` → **让出**（返回一个不注册服务的空对象，日志警告）；`dsh-live-compact` 或 `billion-context` 能从同一棵 `node_modules` 里 resolve 到 → **不接管，跑原版引擎**并警告。注意「装了但禁用」也算冲突，可用 `STRATA_IGNORE_CONFLICTS=1` 跳过。
- `gate.js`：预设配置树里出现这两个包的启用行，或者包已安装 → 不改写预设。
- 工具行：`ctx.compaction` 不是 Strata 引擎时不注册四个工具和系统提示，只注册 `/strata`，说明为什么没接管。
- TUI：没有单独检测。gate 只改写 standard / ptc / minimal / cordis 四个 Web 预设，TUI 预设不动，仍跑原版。

### 11.4 代价估算（§4 的具体公式）

```
cost    = (fold 起点之后的 token − 回收量) × (未命中单价 − 命中单价)    一次性
benefit = 回收量 × 命中单价 × 预计剩余请求数
```

单价默认 1 : 0.1（`STRATA_PRICE_MISS` / `STRATA_PRICE_HIT`，只有比例有意义）。剩余请求数默认取「本会话已经发过的请求数」，夹在 [4, 200]。同一轮的多个 fold 合起来算一次；`benefit < cost` 或回收量低于 `max(5K, 窗口 1%)` 就推迟，最多推迟 3 次轮末，之后丢弃。compress 的返回里写明估算。

### 11.5 和前文的其他差异

- **卡片和指针里不再出现本机绝对路径**：live-compact 1.0.6 的 `pointerFor` 和 `backupHint` 还写绝对路径（README 说 1.0.3 去掉了，实际 1.0.6 代码里还在）。Strata 改成存档 id（`cut-…`、`archive:raw-….txt`），并提示用 `decompress` 取回。
- **L∞ 摘要**：原版摘要前插一块 `[strata:full id=official-…]`，写明存档 id；存档失败也照写「没有存档成功」。
- **`decompress toFile`** 写到会话工作目录下的 `.strata/restore/`（工作目录取最新的 `working-directory/change`，否则 session header 的 `cwd`），因为 `~/.dsh/strata` 可能在文件工具的沙箱外。
- **`emergencyPct` 95% 截断**：§3 表里有，§7 MVP 清单没有，没做。
- **评测**：live-compact 仓库里没有「长填日志」「失忆对比」两套的脚本，`eval/` 是按描述重写的（fill / amnesia / recall 三套，strata 和 stock 两组）。默认只打印计划，`--run` 才真跑，每组用 `eval/.work/` 下独立的 `DSH_HOME`。**本会话没有跑。**
- 去掉了 live-compact 的 `bin/`（指向上游的下载域名）。

### 11.6 多级蒸馏 T1–T3

- **级别从内容推出来**，模型不用指定：范围里只有 raw/card → T1；含有 fold → 里面最高一级 + 1。T3 的 fold 不能再折（返回「T3 is the highest tier」）；official 摘要（full）永远不再折。
- **不会切开下级 fold**：fold 在 surface 上是单个节点，范围要么整个包住它，要么不碰它，所以「不能切开」天然成立；校验时 fold 节点和 raw/card 一样要满足 tool-pairing 边界。
- **标签**：`[strata:fold:t1|t2|t3 id=fN range=sA-sB]`。旧的不带级别的 `[strata:fold …]` 当 T1 读。
- **存档**：`fold-fN.json` 加 `tier` 和 `children`，每个直接子节点记 `kind`（fold / card / raw）、`id`、`tier`、`seq`、`ref` 和指针：下级 fold → `fold-fM.json` + sha256 前 16 位；卡片 → `cut-….txt` + sha256；工具原文 → `raw-….txt` + sha256；其他原话 → DSH 会话日志里的 `sessionSeq`。另外新增 `cards.json`，记录每张 L1 卡片替换了哪些 seq 和工具调用 id，`search_context` 用它从原文找回所属的卡片。
- **checkpoint 文本**：每级都列出直接子节点的 id（`Contains: f1 (T1), f2 (T1), card cut-…`），并把下面各级折掉的工具调用 id 合并列出（R7：摘要的摘要即使丢了细节，下一级的入口还在）。
- **decompress**：默认只往下一级——T3/T2 → 它包含的下级 fold 的摘要（每段标出 `→ decompress({"id":…})`），T1 → 原来的消息和卡片，卡片 → 原文；标题行写出「Next tier: …」。`full:true` 递归到底，卡片换成 cut 原文，工具结果换成 raw 原文。
- **search_context**：每条结果标明级别（raw tool output / card original / T1–T3 fold），并给出从最外层 fold 往下的路径，例如 `f7(T3) → f6(T2) → f3(T1) → raw call-12 [on the surface]`；最外层不在 surface 上时标 `archive only`。
- **strata_status**：多一行 `Folds by tier: T1 … · T2 … · T3 …`（块数和 token）；可折叠区间会标「含 N 个 fold → 会变成 Tn」；单独列出「Upgradable fold groups」（同一可折叠区间里两个以上 fold，从第一个到最后一个）。
- **提醒和门槛**：T3 以下的 fold 也算「可折叠量」，所以提醒同样会覆盖升级。含升级的批次最小收益是普通门槛 × `STRATA_UPGRADE_BENEFIT_FACTOR`（默认 1.5）。

### 11.7 DSH 是否允许 replace 一个含 checkpoint 的范围

**允许。** `dsh-session` 0.2.1-rc.5 的 `planSurfaceEvent` 对 replace 只检查：起止 seq 都在 surface 上且顺序正确（`replacementRange`）；`sourceEventSeqs` 非空、无重复、都早于当前事件，并且**包含所有被替换的 surface 节点**（`assertSourceEventReferences`）；被替换的是 tool/result 时的改写规则（`assertToolResultRewrite`）；第 0 个节点是 system prompt 时只能由 system/message 改写（`assertSystemHeadRewrite`）。没有「不能替换 checkpoint」的规则（原版的大压缩本来就会把旧 checkpoint 一起压掉）。`test/tiers.test.mjs` 最后一个用例直接调用真实的 `foldSurface` 验证：两个 T1 replace 之后再 replace 这两个 checkpoint 成 T2，surface 变成 `[0, T2]`；`sourceEventSeqs` 漏掉被替换节点时报 `must include every shadowed surface node`。Strata 的 `sourceEventSeqs` 是 `[start, summary, ...被替换的 seq]`，满足要求。

### 11.8 真机冒烟（不调模型）

用 DSH Desktop 自带 CLI（`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`，0.2.1-rc.5），临时 `DSH_HOME`，**不设 API key**，所以请求在发出前就因 `MISSING_CREDENTIAL` 失败，不产生费用：

1. 只装 Strata：`--dump-config` 显示 `compaction-basic` 被 `disabled: true`，插入 `compaction-strata` / `strata-gate` / `strata-tools`。启动 headless 后，会话日志的 request header 里有 `compress`、`decompress`、`search_context`、`strata_status` 四个工具和 Strata 的系统提示段；stderr 没有任何「未接管」警告；`agent/pre-step` 的提醒钩子跑过第 1 步没有报错。
2. 同时装 Strata 和 dsh-live-compact：stderr 打出 `strata: 本会话未接管。另一个插件 <LiveCompactEntry> 已经提供压缩。`，request header 里没有 Strata 的工具和提示段——让出路径（构造函数返回不注册服务的空对象）在真实 cordis loader 里可用。这次 live-compact 先加载；Strata 先加载的顺序（会走「包已安装 → 跑原版引擎」那条路）没有在真机上试。

还没验证：真实模型下的 L1 切、fold 落地、提醒注入（需要 API key，属于评测）。

### 11.9 安装与改动记录

全部在临时目录里，没有碰用户日常的 profile、`~/.dsh/settings.yaml` 或任何全局配置。

| 时间 | DSH_HOME / profile | 安装或改动 | 版本 / 来源 |
|---|---|---|---|
| 2026-11-04 | `$TMPDIR/dsh-home-smoke`（`/private/tmp/claude-501/dsh-home-smoke`）/ `headless` | `dsh plugin --profile headless add` Strata 本地包 | `@light-cheng/dsh-strata` 0.1.0，本分支 `npm pack` 的 `light-cheng-dsh-strata-0.1.0.tgz` |
| 2026-11-04 | 同上 | 启动 `dsh headless --json "say hi"`（无 API key），生成一个会话目录 | — |
| 2026-11-04 | `$TMPDIR/dsh-home-conflict`（`/private/tmp/claude-501/dsh-home-conflict`）/ `headless` | 同时安装 Strata 和 dsh-live-compact | Strata 0.1.0（同上）；`dsh-live-compact` 1.0.6，从 `768eff9` 源码本地 `npm pack`，未从上游下载站下载 |
| 2026-11-04 | 同上 | 启动 `dsh headless --json "say hi"`（无 API key） | — |
| 2026-11-04 | — | pnpm 因为不能硬链接用户的 `~/Library/pnpm/store`，自动改用 `/private/tmp/claude-501/.pnpm-store/v11` | pnpm 11.28.5（DSH 自带） |

两个 profile 的设置文件（`cordis.patch.yml`）都保持 DSH 初始化时的空数组 `[]`，没有改。billion-context 没有安装。清理：删掉上面两个 `dsh-home-*` 目录和 `.pnpm-store` 即可。

2026-11-05 补充：
- `smoke` 这个 home 又跑了几次 headless 小任务，都走 magpie（见 §11.10）。
- 真实模型评测每次在 `eval/.work/<时间>/{strata,stock}/dsh-home` 里新建 home，并从本地 `npm pack` 装 Strata。`eval/.work/` 已加进 git 忽略，清理时直接删掉整个目录即可。
- 模型调用都走用户本机的 magpie 网关（`127.0.0.1:3425`），用 `DEEPSEEK_BASE_URL` 加 `--patch` 指过去，没有改任何 profile 文件。

2026-11-05 收尾：
- 已删除 `dsh-home-smoke`、`dsh-home-conflict`、`.pnpm-store`，以及 `eval/.work/*` 下所有 DSH home，只留下各轮的 `results.json`。
- 用户日常的 `desktop` profile（`~/.dsh/profiles/desktop`）：
  - 卸载了 `billion-context` 0.1.212，用的是 `dsh plugin remove`，它同时从 `dependencies` 和 bundles 里去掉；
  - 装上了 `@light-cheng/dsh-strata` 0.1.0，来源是 GitHub Release 的 tarball；
  - 改动前的 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml` 备份在 `~/.dsh/profiles/desktop/.backup-before-strata-20261105/`；
  - 用户自己的 `cordis.patch.yml` 没有改。
- desktop profile 只能由 Electron 应用加载，CLI 不能 `--dump-config`，所以要打开 DSH Desktop，用 `/strata` 确认已经接管。

2026-11-05 补记：
- **v0.1.1 修复。** 修复了 Web / Desktop 预设无法新建会话的问题。验证用的临时 home `/private/tmp/claude-501/dsh-home-web` 已删除。
- **v0.2.0 浮标。** 新增输入框状态浮标，用临时 home `/private/tmp/claude-501/dsh-home-dock` 做 Web 端到端验证（走 magpie），验证后已删除。
- **用户日常的 `desktop` profile。** 0.2.0–0.2.2 用的是 GitHub Release 的 tarball。0.3.0 起改名为 `@lightcheng/dsh-strata` 并发布到 npm；`desktop` profile 已卸掉旧名字，从 npm 装上 `@lightcheng/dsh-strata@^0.3.0`。0.3.0 的验证用临时 home（`dsh-conf-*`、`dsh-web-030`）都已删除。
- **0.4.1（2026-11-06）。** 0.4.0 只打了标签，没发布到 npm。`desktop` profile 用 `dsh plugin --profile desktop add @lightcheng/dsh-strata@^0.4.1` 从 npm 升到 0.4.1，`package.json` 里只改了这一行依赖（`^0.3.0` → `^0.4.1`），其他插件和设置都没动。DSH Desktop 下次启动时，会对 `~/.dsh/strata/` 自动做一次存档清理（标记文件 `.scrub-runtime-context-v2`），用户已同意；重启后用户在 `/strata` 里确认 0.4.1 已接管。

### 11.10 真实模型评测（2026-11-05，recall + tiers）

**环境**
- DSH Desktop 自带 CLI 0.2.1-rc.5，model 是 `workbuddy/deepseek-v4.1-flash`，经 magpie 转发；DSH 认为窗口是 1M。
- 另一个 provider `workbuddy-ai/...-sg` 返回 503，没有用。
- 命令：`DSH_EVAL_PATCH=<把 agent-default-model 的 model 改成 magpie id 的 patch> DEEPSEEK_BASE_URL=http://127.0.0.1:3425/v1 node eval/run.mjs --run --suite recall,tiers`。

**第一轮跑出来的问题，已修，见 `37f2d1c`**
- 源文件还在磁盘上，模型直接重新读文件，根本没有用到恢复工具。现在提问之前先把源文件删掉。
- 窗口是 1M、会话又短，代价估算把小 fold 都推迟了，最后丢掉。这是 §4 的设计行为。但 `compress` 回复第一行写的是「本轮结束落地」，模型照着转述成「已完成」。现在推迟时第一行就写 `compress deferred, NOT applied this turn`。
- 评测里给 Strata 设了 `STRATA_EXPECTED_REQUESTS=50` 和 `STRATA_MIN_BENEFIT_TOKENS=1000`，所以这次测的是折叠和恢复机制本身，不是落地经济学。

**第二轮结果**

| 套件 | 臂 | 召回 | 说明 |
|---|---|---|---|
| recall | strata | 4/4 | fold 落地了；源文件已删，靠 `search_context`、`decompress`（`full:true`、`toFile`）找回，然后 grep 恢复出来的文件 |
| recall | stock | 4/4 | 1M 窗口里根本没压缩，原文一直在上下文里，所以这一项不能说明 Strata 更好 |
| tiers | strata | 4/4 | 只落地了 2 个 T1；T2 和 T3 一次都没做成 |

**第三轮：只跑 tiers，L2 单独测（`STRATA_L1_STOP_RATIO=0.0001`、`STRATA_FORCE_PCT=0.0001`，只在这个套件里设）**

- 中间试过只关 L1，结果第 2 到 4 个 T1 仍然被代价估算推迟。原因是范围小，又离尾部近，§4 的规则就会推迟它，这是对的。新的回复文字起了作用，模型如实转述成「deferred, not applied」。
- 加上强制落地之后，4 个 T1 → 2 个 T2 → 1 个 T3 全部落地，存档里有 7 个 fold。最后 `strata_status` 显示 `T3 419 (1)`。源文件已删，靠 `search_context` 5 次加 `decompress` 1 次，召回 4/4。
- 小毛病：T3 的范围写成了 `s00296–s00292`，起点 seq 比终点大。原因是 fold checkpoint 拿的是新的 seq，surface 顺序和 seq 数字大小对不上。功能没问题，但看着让人困惑。可以考虑让 ref 按 surface 位置显示，或者在 status 里注明。

**结论：插件里 L1 先、L2 后的顺序不改。** 每轮 L1 切卡片便宜、不调模型。真实长会话里，一个 T1 fold 会盖住很多张卡片，收益够大才落地。原来的评测每读完一个小任务就要求 fold 一次，不像真实的用法。

**第四轮：amnesia（含 fill），窗口 400K，两臂都跑**

**环境与修正**
- 窗口：`DSH_CONTEXT_WINDOW` 在 headless profile 里不生效。要在 patch 里写 `llm-deepseek` 的 `defaultContextWindow: 400000`，会话日志里 `contextWindow: 400000` 确认生效。
- fill 题目：第一次的异常行 level 字段不是 ERROR，已改正。
- fill 提示：stock 第一次把读文件派给了 subagent，提示里已改成「本会话自己读，不许委派」。

**结果**

| 臂 | 请求数 | 输入 token | 单次请求峰值 | 记住 3 条事实 | fill 找到 ERROR 行 |
|---|---|---|---|---|---|
| strata | 20 | 1.11M | ~87K | 3/3 | 0/2，读到第 6 个文件后停下，说明做不到 |
| stock | 46 | 2.75M | ~88K | 3/3 | 0/2，声称全读完、没有 ERROR，**这是假的** |

**读法**
- **fill 在 DSH 里压不出上下文压力。** DSH 自己会把大工具结果的中间部分截掉（`[... tool result middle pruned ...]`），所以两臂峰值都只有约 87K，远低于 400K。stock 做过一次官方整段摘要，Strata 只切了 L1 卡片。
- 要测窗口压力，需要换一种不会被截掉的累积方式，比如很多次小的读取，或者长的对话文字。
- **Strata 的 3 次 `compress` 都没落地：**
  - 第 1 次被推迟了，那一版还是旧的回复文字，第一行没写 deferred，原因同第一轮；
  - 第 2 次的 ref 不在 surface 上；
  - 第 3 次和还没落地的 f1 重叠。
- **模型指出了一个真实的设计限制：** fold 只在本轮结束时落地，所以一轮很长的任务里，L2 帮不上忙。轮内的压力只能靠 DSH 官方触发去走 L∞。这符合 §2.2 的设计，但 README 里应该写明。
- amnesia 两臂都是 3/3：峰值低，事实一直在上下文里，所以这一项也区分不出两臂。

**还没解决**
1. **L1 会先吃掉 L2 要折的东西（评测层面已经处理，见上）。** 每轮结束时 L1 先把读文件的输出切成卡片，下一轮再让模型 fold，这段只剩几百 token，`compress` 会以「摘要不比原范围小」拒绝，或者回收太少被推迟。所以真实模型下 T2/T3 没被走到，单测覆盖了，真机还没有。可选的办法：
   - L2 nudge 早于 L1 切卡；
   - 允许 fold 用卡片背后存档的 token 数估算收益；
   - 或者评测改用不会被 L1 切掉的长对话内容。
2. **stock 臂在 1M 窗口里不压缩。** 要和 stock 拉开差距，需要 fill 或 amnesia 那种超过阈值的长任务，这两项还没跑。
3. **评测分数只看答案里有没有关键串。** `tools` 字段记录了实际调用了哪些工具，可以用来判断是真恢复还是绕过去的。

### 11.11 轮次中途折叠（75% 以上）：不做，以后再看（2026-11-06）

**决定：** 用户决定不做（"Skip it"）。没有实现，也没有放在开关后面。**以后再看（revisit later）。**

自动摘要只在轮次结束时落地。曾考虑在单轮内上下文超过 75% 时就地折叠。不做的依据（数据见共享报告 "Nudge re-arm + automatic digests"）：

- **单轮增长有限。** JIMA 在 1M 窗口里平均每轮约 75K（6 轮 447.7K，239 步）。128K 的 effect 对比跑里，每一组单轮最多涨 20–27% 窗口（25–34K）。
- **很难在一轮里越过 75%。** 自动摘要在轮次结束时把上下文降到约 30%（后来改为：固定开销之外的部分降到 30%，见 §11.12），下一轮要在一轮之内再加超过 45% 窗口（1M 下约 450K，JIMA 平均一轮的 6 倍）才会越过 75%。已有数据里没有接近的。
- **缓存代价。** 中途折叠和轮末折叠单次代价相同：一次未命中，量是（上下文 − 折叠起点）。例如 1M 下 75% 时从 10% 处开始折叠，约 650K 未命中一次，约合 9 次请求的缓存输入（未命中:命中价格 10:1）；之后每次请求少约 45K 命中 token，约 13–15 次请求回本。轮末折叠时，如果用户停顿让缓存过期，这次未命中本来就要付；中途折叠总要付，而且长轮次里可能折好几次。
- **DSH 里的落地路径没验证。** Strata 的折叠在 `turn/end` 之后的 `agent.runMaintenance` 里落地。中途折叠只能走压力路径（`compactIfNeeded(agent, "pressure")`，原版在打开的轮次里、`agent/pre-step` 上运行）或 Strata 自己的 pre-step hook。原版允许在轮次中途写 compaction 事件，但 Strata 在打开的轮次里 replace 更早的范围没测过：当前步的 tool-call/result 配对和运行时上下文快照都必须留在范围外，L1/L2 的记账（pending、baseline）也假设轮末顺序。
- **L∞ 可能在 75% 之前就触发。** 原版阈值是 min(0.8 × 窗口, 窗口 − 适配器 maxTokens − headroom)。maxTokens 大时这条线低于 75%（例如 1M − 256K − 64K ≈ 68%），75% 的中途触发就永远轮不到。

**以后重新考虑时的做法：** 在压力路径里、调用官方摘要（L∞）之前先落地自动摘要，放在开关后面；前提是先有一次真的在单轮内越过 75% 的运行数据。

### 11.12 自动摘要的目标不含固定开销（2026-11-06）

用户的 Windows 会话（0.4.1）总量 290.5K，其中 raw + card 只有约 167K，其余约 123K 是系统提示、工具定义、技能列表和运行时上下文，折叠动不了。原来的目标是「总量 ≤ 30% × 窗口」，所以开销大的会话会折过头；开销加受保护尾部接近目标时 `need` 永远到不了 0，每轮都把剩下的可折叠内容再折一遍（成本检查只能压住一部分）。

- **固定开销**：最初算成 DSH 的 `totalTokens − surfaceTokens` + 表面上的 system 行，这是错的，见下面「校准」。`strata_status` 和 `/strata detail` 单独一行显示。
- **目标** = 固定开销 + `STRATA_AUTO_FOLD_TARGET_PCT` × (窗口 − 固定开销)。触发条件（≥50% 且有未回应提醒 / ≥60%）仍按真实总量。
- **不空转：** 一次自动摘要落地后，要等可折叠量再涨 `STRATA_NUDGE_GROWTH_TOKENS`（或总量 ≥ 75%）才会再折；剩下的只有固定、受保护或已折叠的内容、折完也到不了目标时，不提议（75% 以上仍折能折的）。

**校准（2026-11-07）。** 用户在 Windows 上测 main（d346af6）时，「固定开销」每轮涨约 40K。原因：DSH 的 `totalTokens` 以服务商上一次真实的 prompt 用量为锚（加启发式增量），而 `surfaceTokens` 和每个节点的 tokens 都是 chars/4 启发式。日志、数字、时间戳在 DeepSeek 上的实际 token 远多于 chars/4，所以 `total − surface` 里装的是每条消息的估算误差，随读入内容一起涨。各行之和与 `surfaceTokens` 完全相等（节点没有漏算的部分），也没有重复计数。复现（`eval/measure-repro.mjs`，magpie，每轮 5 个约 11K 的日志）：

| 轮 | total | surface | 工具（启发式） | 旧「固定」 | 比例 | 新「固定」 |
|---|---|---|---|---|---|---|
| 1 | 106.2K | 59.1K | 5.5K | 48.0K | 1.645 | 10.5K |
| 2 | 165.5K | 92.9K | 5.5K | 73.6K | 1.683 | 10.7K |
| 3 | 225.7K | 127.5K | 5.5K | 99.0K | 1.697 | 10.8K |
| 4 | 305.0K | 172.8K | 5.5K | 133.0K | 1.710 | 10.9K |

现在：固定开销按启发式单位算（表面上的 system 行 + DSH `contextBreakdown` 投影里的 `toolsTokens`，经 `ctx.sessionProjections` 读取），再乘以本会话的比例 `total / (surface + tools)`（限制在 0.25–8）。拿不到投影时，用本会话见过的最小 `total − surface` 当作工具（服务商单位），比例只按表面算。自动摘要的 need 是服务商单位，换算成本地单位（÷ 比例）再和各段的回收量比。比例偏离 1 超过 5% 时，`strata_status` 在固定开销那行注明。`STRATA_MEASURE_TRACE=<文件>` 在每次轮末写一行测量记录（默认不写）。

**步长按服务商 token（2026-11-07）。** 提醒步长 `STRATA_NUDGE_GROWTH_TOKENS`（含 ½ / ¼ 重新提醒）和自动摘要后的等待量，现在都按服务商 token 计：比较前把设置值除以上面的比例，换成本地估算单位。`strata_status` 写成 `+50.0K (provider; ~29.2K local at ×1.71)`。L1 的 32K 上限和代价估算不变。

**挂起的模型折叠不再挡住自动摘要（2026-11-07）。** Windows 复测（8cb8506）：69.7% 也没有自动摘要。`autoFold` 开头有 `if (state.pending.length) return []`；模型的 compress 被代价检查推迟时会挂起最多 `STRATA_MAX_DEFER_TURNS`（3）轮，期间每个轮末都直接返回。现在挂起折叠的回收量计入目标，自动摘要只折它们范围以外的部分（按挂起范围切开、两端保持工具调用配对），和它们同批过代价检查。每个轮末的结果记在 `strata_status` 的 `Automatic fold at last turn end: …` 一行（landed / skipped 原因 / 未落地原因 / error）。

**时间线更正与批次规则（2026-11-07）。** 实际经过：第 5 轮模型的 compress 成为挂起的 T1 f1，被代价检查推迟；第 6–7 轮上下文超过 60%，`autoFold` 因为有挂起项直接返回；第 8 轮末超过 75% 时 f1 被强制单独落地（重算约 457.6K，只回收约 115.2K），停在 69.7%。现在：
- 轮末到达自动折叠线时，挂起的模型折叠和自动摘要组成一批（摘要绕开挂起范围、按轮切分、从最旧的开始，直到够目标），一次落地、一次缓存未命中。到达自动折叠线时，含模型折叠的这一批不再被代价检查推迟（`autoDue`），低于这条线时照旧过代价检查。
- 一次落地后仍高于目标，同一个轮末再跑一轮（最多三轮，都在下一次请求之前，所以仍只有一次未命中）。
- +50K 等待只在上一次自动尝试「能折的都折了」（走完所有段仍未达到 need）之后生效；达到 need 的折叠或单独落地的模型折叠不触发等待。

**受保护尾部上限（2026-11-07）。** Windows 复测（6bc1f4b）：四段自动摘要落地后停在 39.7%，目标约 330K。原因是受保护尾部（最近 3 轮工具调用）每轮是 5 个并行的约 11K 读取，三轮约 117.8K 本地 ≈ 357K 服务商（×3.03）。现在尾部取最近 `STRATA_KEEP_ROUNDS` 轮和 `STRATA_PROTECTED_TAIL_PCT` × 窗口（默认 10%，服务商 token，÷ 比例换成本地）中较小的：从最新一轮往前加，加上一轮会超过上限就停；最新一轮无论多大都完整保留；边界总在发起调用的助手消息上，所以调用和结果不会分开。最新用户消息和当前运行时上下文快照照旧受保护。L1 用自己的 `STRATA_KEEP_ROUND_TOKENS`，不受影响。`strata_status` 一行 `Protected tail: …` 写出轮数、本地和服务商大小，以及是否被上限截短。
