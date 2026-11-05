# dsh-strata × DSH-Mem0 互操作约定（草案 v1，2026-11-05）

dsh-strata 牵头起草，DSH-Mem0 确认后两边各自实现。版本基线：dsh-strata 0.3.0，DSH-Mem0 0.3.0，DSH 0.2.1-rc.5。

## 0. 现状（已核实）

| 内容 | DSH-Mem0 放在哪 | DSH 怎么落到会话里 | dsh-strata 0.3.0 怎么处理 |
|---|---|---|---|
| 记忆摘要 | `plugin:dsh-mem0:profile` 系统提示段（`memory-lifecycle.js:174-185`） | 系统提示，surface 第 0 个节点 | 不碰，正确 |
| 每轮召回 | `system-prompt/assemble` 结果的最后一个 context，名字 `mem0:recall`（`:194-197`） | 所有 context 合成一份 **runtime-context 快照**：`user/message`，`source = { kind: "runtime-context", form: "snapshot", sections: [...] }`，正文开头是「Current runtime context. This snapshot supersedes earlier runtime-context snapshots.」。任一段变化就**追加一份新快照**，旧的留在历史里 | `stratumOf()` 只认 `compact-checkpoint`，快照被当成普通 `raw`：照样存档（`raw-*.txt`）、切进卡片、算进可折叠量、折叠进摘要 |
| 捕获 | `session/event` 实时收集 `source.kind === "user"` 的用户消息和最后一条 assistant 消息，`turn/end` 时入队（`:281-333`） | — | Strata 的切卡和折叠都在 `turn/end` 之后的 `agent.runMaintenance` 里；替换生成的 checkpoint 是 `source.kind = "compact-checkpoint"`，Mem0 不收 |

问题：每次召回内容变化都会多一份快照，默认预算下每份约 2.2K token。长会话里旧快照会堆到几十万 token，而它们已经被新快照声明作废。Strata 现在会存档、切卡、折叠它们，白占空间，还会把过时的记忆写进 L2 摘要。

## 1. 旧快照：直接丢掉，最新一份不动（通用规则）

**规则适用于所有 runtime-context 快照，不只是 Mem0 的。** DSH 自己在快照里声明「本快照替代更早的快照」，所以除了最新一份，其它都是作废内容。这条规则对任何往 `contexts` 里放东西的插件都成立。

dsh-strata 这边：

1. **新的分类。** `stratumOf()` 识别 `source.kind === "runtime-context" && source.form === "snapshot"`：
   - 最新一份记为 `context:live`，放进保护区，L1、L2 都不能碰；
   - 更早的记为 `context:stale`。
2. **stale 不存档、不切卡、不折叠。**
   - L1 切卡时，范围里的 stale 快照直接丢掉，卡片只写一行「丢弃了 N 份过期运行时上下文」，不进 `raw-*.txt`，也不进卡片原文存档；
   - L2 折叠的范围可以包含 stale，但 fold 存档的 `children` 里记成 `dropped`，不保存原文，也不让模型把它写进摘要；
   - `strata_status` 单独列出 stale 的 token 数，不算进「可折叠」。
3. **清理时机，以前缀缓存为准。**
   - **顺带清理（不额外花钱）：** 本轮已经有 L1 切卡或 L2 折叠，前缀已经从位置 P 断开时，把 P 之后所有 stale 快照一起换成空 checkpoint，同一次维护提交。
   - **单独清理：** stale 累计 ≥ `max(8K, 窗口 × 1%)`，并且按 §4 的代价公式划算时，在轮末单独清一次。上下文超过 75% 时不看代价直接清。
   - 每份 stale 换成一个约 20 token 的空 checkpoint，标签 `[strata:dropped kind=runtime-context]`。DSH 只有 replace，不能真的删除。
4. **最新一份永远原样保留**，也不改它的位置。快照内容由 DSH 生成，Strata 不改写任何一段。

DSH-Mem0 这边：不用改。可选：召回结果没变时不要改动 `mem0:recall` 的文本（现在已经是这样），以免产生没必要的新快照。

## 2. 统一 token 预算

现状是两边各算各的：Mem0 有 `profileBudgetTokens`（默认 1375）、`memoryBudgetTokens`（默认 2200）和自己的 `estimateTokens`；Strata 用 DSH 的 `tokenMeter`。

约定：

1. **Strata 提供一个只读服务 `strataBudget`。** 它是 cordis service，Mem0 用 `ctx.inject(['strataBudget'], ...)` 选择性注入；没装 Strata 时 Mem0 照旧工作。
   - `pressure(session) → { totalTokens, window, ratio, stage }`，`stage` 取 `normal` / `tight`（≥ 65%，L1 停切线）/ `critical`（≥ 75%，强制落地线）。
   - `allowance(session, name, wanted) → number`，返回这一段这一轮最多可以用多少 token：
     - `normal`：给足 `wanted`；
     - `tight`：给 `wanted` 的一半；
     - `critical`：给 `min(wanted, 512)`；
     - 摘要段（name 以 `:profile` 结尾）在 `tight` 档不减。
   - 计数统一用 DSH `tokenMeter`。Mem0 原来的 `estimateTokens` 只用来在 Mem0 内部裁剪文本。
2. **Mem0 调用方式：** 召回前 `allowance(session, "mem0:recall", memoryBudgetTokens)`，摘要用 `allowance(session, "plugin:dsh-mem0:profile", profileBudgetTokens)`，拿到的数作为本轮上限。
3. **Strata 的记账：** 系统提示段和最新快照都算「保护层」，`strata_status` 和浮标的占用数字里都包含；stale 单独列出。

## 3. 记忆捕获和压缩的先后顺序

分析结论：**Mem0 存的是原文，不受 Strata 影响。**

- Mem0 在事件到达时就拿到文本：用户消息在 `user/message` 事件里，assistant 回复在 `assistant/message` 事件里，到 `turn/end` 才入队。
- Strata 的 L1、L2 都在 `turn/end` 之后的 `agent.runMaintenance` 里运行，只改 surface，不改已经发出的事件。
- 轮内如果触发了官方整段摘要（L∞），插进来的是 `compact-checkpoint`，Mem0 按 `source.kind` 过滤掉了。

仍然要实测（见 §5）：一个长回合里中途触发 L∞，检查 Mem0 捕获到的用户消息和最终回复，是否和原文逐字一致。

## 4. 互相利用（可选，第二阶段）

- **折叠摘要作为记忆来源。** L2 落地后，Strata 发出 `strata/fold-landed` 事件 `{ sessionId, foldId, tier, topic, summary, range }`。Mem0 如果愿意，可以把 T1 摘要当成一段「已经整理过的对话」捕获，`metadata.source = "dsh-strata"`、`metadata.fold = foldId`，能解决原评审里 I2 提到的中间叙述噪声。默认关闭，由 Mem0 配置开启。
- **反向：Mem0 记住的就可以放心折叠。** 暂不做。Strata 的原文全在本地存档，折叠本来就不会丢细节，收益不大。

## 5. 联合测试（两个插件同时装）

在临时 profile 里同时装 Mem0（OSS 或 mock 后端）和 Strata，模型走 magpie：

| 编号 | 场景 | 通过标准 |
|---|---|---|
| J1 | 连续 6 轮，每轮的问题都不同，召回内容每轮都变 | 第 6 轮结束后 surface 上只有最新一份快照保持原文，其余都是 `dropped` 或已清理；`<DSH_HOME>/strata/` 下没有任何 runtime-context 快照的原文 |
| J2 | 在含有旧快照的范围上 `compress` | fold 存档的 children 里快照记为 `dropped`，摘要里不出现召回原文 |
| J3 | 长回合：一次请求里大量工具调用，中途触发 L∞ | Mem0 捕获的用户消息和最终回复和原文逐字一致 |
| J4 | 缓存命中率 | 同一脚本分别在只装 Mem0、两个都装的情况下跑，后者命中率不低于前者；顺带清理不额外增加未命中次数 |
| J5 | 预算 | 把上下文推过 65% 和 75%，`mem0:recall` 的长度分别降到一半和 512 以内 |
| J6 | Web 界面 | 两个浮标并排：Mem0 地球仪在召回和保存时滚动，Strata 在折叠和清理时播放动画，互不干扰 |

## 6. 分工

| 事项 | dsh-strata | DSH-Mem0 |
|---|---|---|
| §1 旧快照规则 | 实现（分类、不存档、清理） | 无需改动 |
| §2 预算服务 | 提供 `strataBudget` | 选择性注入，按 `allowance` 裁剪 |
| §3 顺序 | 写 J3 测试 | 确认捕获只依赖事件 |
| §4 折叠作为记忆来源 | 发 `strata/fold-landed` 事件 | 可选：按配置捕获 |
| §5 联合测试 | 牵头搭环境、跑 J1–J6 | 提供 mock 后端或 OSS 配置 |

## 7. 待 DSH-Mem0 确认

1. §2 的分档比例（一半 / 512）和「摘要段在 tight 档不减」是否可以接受。
2. §4 第二阶段是否要做；如果做，摘要捕获默认关闭是否同意。
3. 联合测试用哪个后端：mock 后端（可复现）还是本地 OSS（真实）。
