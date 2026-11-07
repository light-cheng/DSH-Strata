# Release notes

English is the default; the Chinese version follows below.

## English

### Unreleased

- **Quality preset with mid-turn digests (`STRATA_PRESET=quality`):** automatic-fold line 25 %, force line 35 %, target 15 % (the default `cost` preset keeps 50 / 60 / 30 %). In this preset, before a step and above the force line, digests of the turns before the current one land at once, ahead of DSH's official summary (L∞), which then runs only if they were not enough. The current turn (its tool calls and results) and the live runtime context are never touched, and a pending model fold stays pending for the turn end. `STRATA_MID_TURN_FOLD=off` keeps folds at turn end; `STRATA_NUDGE=off` stops the fold reminders and leaves folding to digests. `strata_status` adds a `Preset:` line and, with mid-turn digests on, `Mid-turn digests …: N landed; last: …`.
- **Mid-turn digests reach the current turn (`STRATA_MID_TURN_CURRENT=on`, `quality` only, off by default until validated live):** after the earlier turns, a mid-turn digest also covers the current turn's finished tool rounds outside the protected tail, oldest first, each round whole. The step in flight, the turn's user message and the live runtime context stay. A single long turn (hundreds of K of shell output or images) no longer climbs unchecked toward L∞. `STRATA_MID_TURN_CURRENT=off` keeps mid-turn digests to earlier turns; the cost preset never folds mid-turn.
- **Digests per tool round:** automatic digests are now cut per tool round (an assistant message and all its results, never split; small rounds merge into pieces of at least 2K), oldest first, and the walk stops before a round would take context more than half that round below the target. Before, a whole turn was one piece and a turn of five parallel 11K reads overshot the target by about 17 % of the window.
- **Turn end no longer folds far past the target:** right after a fold lands, DSH's total stays anchored on the last request until the next one, so the second and third turn-end passes kept folding on the old total (53 % → 3.9 % against a ~16 % target in a real run). Later passes now use the previous pass's total minus what landed.
- **Plugin page:** DSH's plugin page now shows a short document in the UI language (what Strata does, its core features and a link to the repository; `docs/plugin-page.en.md`, `docs/plugin-page.zh-CN.md`, named by `meta.detail` in `locale/en.json` and `locale/zh.json`; other languages fall back to English) instead of the GitHub README with its language-switch line.
- **`/strata` help and a sectioned detail:** `/strata` and `/strata help` list the subcommands; `/strata status` is a short summary; `/strata detail` is split into overview, layers, automatic folds, foldable ranges, cache and cost, and recent changes, with aligned columns (DSH shows command output as plain text, so no tables; in its web view a CJK character is narrower than two Latin ones, so Chinese labels are padded with ideographic spaces); `/strata detail full` adds every message of each foldable range. Output follows the UI language (Chinese or English; the composer dock reports it). The cost section adds a per-session ledger of landed changes: re-billed, reclaimed and the estimated net saving at the cache prices. `/strata purge` now only explains what it would delete; `/strata purge confirm` deletes. `strata_status` for the model is unchanged.

- **Reminders reach the model inside long turns:** the fold reminder used to wait for the next user message, so a 40-step turn saw at most one. It now fires on any step once foldable context has grown by 50K, and an unanswered reminder comes back after another 25K (12.5K above 75 % of the window).
- **Reminder step and digest wait in real tokens:** the 50K reminder step (and its ½ / ¼ re-arm) and the 50K wait after an automatic digest now count provider tokens: local estimates are divided by the session's provider/estimate ratio (about 1.7 on log text). `strata_status` shows both, e.g. `next nudge at +50.0K (provider; ~29.2K local at ×1.71)`.
- **Protected tail capped at 10 % of the window:** folds never touch the last three tool rounds, but rounds of five parallel ~11K reads made that tail ~357K provider tokens, so digests stopped at 39.7 % instead of the ~33 % target. The tail is now the smaller of the last three rounds and ~10 % of the window (provider tokens); the newest round always stays whole, and the boundary never separates a call from its results. `STRATA_PROTECTED_TAIL_PCT` (0.10; `0`/`off` disables). `/strata detail` shows e.g. `Protected tail: last 1 of 3 tool rounds, ~56.1K local (~169.9K provider), capped at 10% of the window; the newest round alone is larger and stays whole.`
- **Digests are no longer blocked by a pending model fold:** a model `compress` deferred by the cost check stays pending for up to three turns, and while it did, no automatic digest ran (a Windows test stayed at 69.7 % with no digest). Pending folds now count toward the target and digests fold around their ranges in the same batch. Above the automatic-fold line (60 %, or 50 % after two unanswered reminders) a pending model fold lands with that batch instead of waiting for 75 %; digests are cut per turn so the batch stops near the target; when one landing leaves context above the target, the same turn end runs another pass; the +50K wait applies only after an attempt that folded all it could. `strata_status` says what the last turn end did: `Automatic fold at last turn end: landed f4` / `skipped (…)` / `proposed f4, not landed (…)`.
- **Automatic digests:** when the model leaves two reminders unanswered and context is above 50 % of the window (or above 60 % regardless), Strata folds the oldest work at turn end without calling the model, until the foldable part is about 30 % of the window minus fixed overhead (system prompt, tool definitions; shown in `strata_status`); the next digest waits for another 50K of foldable work or 75 %. Fixed overhead is calibrated: DSH's total follows the provider's real token counts while layer sizes are a chars/4 estimate (log text ran ×1.65–1.71), so the overhead is the estimated tool and system price times that ratio, not total minus surface. A digest keeps user messages, the start of assistant replies, every tool call with its path or command and first result line, and errors; it is tagged `auto=1`, archived and restorable like any fold, and goes through the same cost check. `strata_status` counts digests separately; the dock shows `Auto fold`; the `strata/fold-landed` event carries `auto: true`. All thresholds have `STRATA_*` knobs; `STRATA_AUTO_FOLD=off` disables it.

### v0.4.1 — DSH-Mem0 兼容 / DSH-Mem0 interop

0.4.0 was tagged but never published to npm, so 0.4.1 is the first npm release of the DSH-Mem0 interop work. It contains everything listed under 0.4.0:

- **Runtime-context snapshots** (for example DSH-Mem0's recalled memories): only the newest stays on the surface; superseded ones are never archived, carded or folded, and are replaced by a `[strata:dropped kind=runtime-context]` placeholder at turn end (free when the prefix already broke, otherwise when it pays, always above 75%). See `docs/interop-dsh-mem0.md`.
- **`strataBudget` service** (pressure / allowance / countTokens) for context plugins, and a `strata/fold-landed` event.
- **Archive privacy fix:** the span an official summary replaces (`official-*.txt`) and card backups no longer keep runtime-context snapshots; they are written as the placeholder. System prompts are no longer archived at all (they are rebuilt on every request); a one-line `[system prompt omitted]` marks where they were, so the archive holds no copy of, for example, DSH-Mem0's `<mem0-user-profile>`.
- **One-time archive scrub:** on the first start after upgrading, Strata walks `<DSH_HOME>/strata/` once and cleans existing archive files left by 0.3.0: runtime-context snapshots and `<mem0-relevant-memories>` blocks become the same placeholder, `<mem0-user-profile>` blocks become `[strata:dropped kind=user-profile]`, and system-prompt sections in official-summary archives become `[system prompt omitted]`. Other text stays byte-identical, files stay `0600`, and a marker file (`.scrub-runtime-context-v2`) keeps it from running again; the log line says how many blocks were scrubbed. To remove a session's archive entirely, use `/strata purge`.
- **`strata_status` warning:** when DSH's automatic compaction is off because the request's `maxTokens` plus headroom do not fit the context window, `strata_status` starts with a warning line naming the model.
- **Composer dock:** when a fold, a card and a cleanup land in the same turn end, the dock now plays the fold instead of whichever came last.

New in 0.4.1:

- **`strata_status` warning:** strata_status warns when DSH's official summary keeps failing (e.g. its summary cap, which defaults to headroomTokens, is too small).

Compatibility: pairing with dsh-mem0 0.3.0 works; the `strataBudget` recall budget and fold capture need dsh-mem0 newer than 0.3.0.

Verification:
- 54 unit tests pass; `npm run check` passes; the packed tarball contains no local paths.
- Joint test with DSH-Mem0 (J1–J6: snapshots, fold, capture, cache, budget, Web docks), DeepSeek V4.1 Flash: all pass.

### v0.4.0 — tagged, not published to npm

- **Runtime-context snapshots** (for example DSH-Mem0's recalled memories): only the newest stays on the surface; superseded ones are never archived, carded or folded, and are replaced by a `[strata:dropped kind=runtime-context]` placeholder at turn end (free when the prefix already broke, otherwise when it pays, always above 75%). See `docs/interop-dsh-mem0.md`.
- **`strataBudget` service** (pressure / allowance / countTokens) for context plugins, and a `strata/fold-landed` event.
- **Archive privacy fix:** the span an official summary replaces (`official-*.txt`) and card backups no longer keep runtime-context snapshots; they are written as the placeholder. System prompts are no longer archived at all (they are rebuilt on every request); a one-line `[system prompt omitted]` marks where they were, so the archive holds no copy of, for example, DSH-Mem0's `<mem0-user-profile>`.
- **One-time archive scrub:** on the first start after upgrading, Strata walks `<DSH_HOME>/strata/` once and cleans existing archive files left by 0.3.0: runtime-context snapshots and `<mem0-relevant-memories>` blocks become the same placeholder, `<mem0-user-profile>` blocks become `[strata:dropped kind=user-profile]`, and system-prompt sections in official-summary archives become `[system prompt omitted]`. Other text stays byte-identical, files stay `0600`, and a marker file (`.scrub-runtime-context-v2`) keeps it from running again; the log line says how many blocks were scrubbed. To remove a session's archive entirely, use `/strata purge`.
- **`strata_status` warning:** when DSH's automatic compaction is off because the request's `maxTokens` plus headroom do not fit the context window, `strata_status` starts with a warning line naming the model.
- **Composer dock:** when a fold, a card and a cleanup land in the same turn end, the dock now plays the fold instead of whichever came last.

Verification:
- 52 unit tests pass; `npm run check` passes; the packed tarball contains no local paths.
- Joint test with DSH-Mem0 (J1–J6: snapshots, fold, capture, cache, budget, Web docks), DeepSeek V4.1 Flash: all pass.

### v0.3.0 — published on npm as `@lightcheng/dsh-strata`

- The package is renamed from `@light-cheng/dsh-strata` (GitHub releases only) to **`@lightcheng/dsh-strata`** and published on npm: `dsh plugin --profile desktop add @lightcheng/dsh-strata`.
- Upgrading from 0.1–0.2: remove `@light-cheng/dsh-strata` first. While the old name is installed, the new package does not take over and logs a warning; DSH's stock compaction keeps running.
- No behaviour changes otherwise.

Verification:
- 36 unit tests and four script tests pass; `npm run check` passes; the packed tarball (35 files, 97.7 kB) contains no local paths, and every relative import resolves.
- Real CLI, headless, DeepSeek V4.1 Flash: Strata alone takes over; with `dsh-live-compact` installed before **or** after it, and with the old `@light-cheng/dsh-strata`, it yields with a warning; with its engine forced to fail, DSH's stock compaction runs.
- Real-model eval: recall 4/4 from the archive after the source file was deleted; a full T1 → T2 → T3 chain landed (7 folds) and 4/4 facts came back through `search_context`.
- Web: no takeover warnings across presets; the plugin page shows **Strata 分层上下文** with icons and names for all three components; the composer dock renders and tracks context use.

### v0.2.2 — display names

- The plugin page now shows localized names and descriptions, in the same format as DSH-Mem0: **Strata Context** / **Strata 分层上下文**, with its own entries for the preset gate and the context tools (`locale/*.json`, `locale/gate/*.json`, `locale/tools/*.json`).

Verification: 36 unit tests pass; all six locale specifiers and three icon specifiers resolve from an installed copy.

### v0.2.1 — component icons

- The `strata-gate` and `strata-tools` components now show the Strata icon on the plugin page too (`exports["./gate/icon"]`, `exports["./tools/icon"]`). DSH reads a subpath component's icon only from `<specifier>/icon`.

Verification: 36 unit tests pass; the three icon specifiers resolve from an installed copy.

### v0.2.0 — composer dock

- New composer dock, next to dsh-mem0's memory globe below the chat composer: an 18px strata glyph in the family's black / white / grey, showing context use (`Strata 4.9%`). When a layer changes the context it plays once — a grain drops into the top layer for an L1 card, or sinks through every layer for an L2 fold or the official summary — and the label shows the reclaimed tokens (`Fold T1 −23.3K`). Light blue on success, red on failure, still when reduced motion is on; clicking it opens the plugin page.
- New read-only route `GET /dsh-strata/gui/status?session=…` behind DSH's request check. It returns token counts and event kinds only.
- The plugin page now shows the Strata icon (`exports["./icon"]`).

Verification: 36 unit tests pass; `npm run check` and `npm pack` pass; in a temporary Web profile with DeepSeek V4.1 Flash, a real fold landed and the dock played the animation, showed `折叠 T1 −4.1K` in light blue, then returned to `Strata 1.0%`.

### v0.1.1 — new sessions in Web / Desktop presets

- Fixed: with Strata installed, DSH Desktop and Web could not open a new session (`agent-preset/invalid: command-compact … waiting for compaction`). Each agent preset isolates its compaction service, but the takeover check looked at cordis's global service store, saw Strata's own engine in a sibling preset and stepped aside, leaving that preset with no compaction. The check now only looks at the service in its own scope; every preset gets its own Strata engine.
- New README in English and Chinese, plugin icon, and these release notes.

Verification: 34 unit tests pass; `npm run check` and `npm pack` pass; a temporary Web profile that reproduced the error with v0.1.0 boots without takeover warnings and opens a new session.

### v0.1.0 — first public release

Strata Context is a layered, restorable context-management plugin for DeepSeek Harness.

Highlights:

- L1 tool cards: deterministic tail cuts at every turn end, no model call, prefix kept byte-identical.
- L2 model-written folds in three tiers (`compress`), validated immediately and landed together at turn end after a cache cost/benefit check.
- L3 local archive of every replaced original; tier-by-tier `decompress` and BM25 `search_context` with expansion paths.
- `strata_status` and `/strata` show tokens per layer and per tier, foldable ranges and pending folds.
- DSH's official summary stays as the fallback; Strata yields to `dsh-live-compact` and `billion-context` when either is installed.

Verification: 32 unit tests pass; real-model runs with DeepSeek V4.1 Flash recovered facts from deleted files through the archive and landed a full T1 → T2 → T3 chain (design §11.10).

## 简体中文

### 未发布

- **质量优先预设和轮次中途摘录（`STRATA_PRESET=quality`）：** 自动折叠线 25 %、强制线 35 %、目标 15 %（默认的 `cost` 预设仍是 50 / 60 / 30 %）。这个预设下，在某一步之前、上下文超过强制线时，当前轮之前各轮的摘录立刻落地，排在 DSH 官方摘要（L∞）之前；摘录不够时才轮到 L∞。当前轮（它的工具调用和结果）和当前运行时上下文从不动，挂起的模型折叠留到轮末。`STRATA_MID_TURN_FOLD=off` 只在轮末折叠；`STRATA_NUDGE=off` 不再提醒模型，折叠交给自动摘录。`strata_status` 增加 `Preset:` 一行，开启中途摘录时还有 `Mid-turn digests …: N landed; last: …`。
- **中途摘录覆盖当前轮（`STRATA_MID_TURN_CURRENT=on`，只在 `quality` 下，实测验证前默认关闭）：** 之前各轮摘录完后，中途摘录还会处理当前轮在受保护尾部之外、已完成的工具回合，从旧到新，每个回合整体处理。正在进行的那一步、本轮的用户消息和当前运行时上下文都不动。单个很长的轮（几百 K 的 shell 输出或图片）不会再一路涨到 L∞。`STRATA_MID_TURN_CURRENT=off` 让中途摘录只处理之前的轮；`cost` 预设从不在轮中折叠。
- **摘录按工具轮切分：** 自动摘录现在以工具轮为单位（一条助手消息加上它的全部结果，从不拆开；小轮次合并成至少 2K 的段），从最早的折起；如果再折一轮会让上下文低于目标超过这一轮的一半，就在它之前停下。以前整轮是一段，每轮并行读 5 个 11K 日志时会比目标多折约 17 % 窗口。
- **轮末不再远远折过目标：** 一次折叠落地后，DSH 的总量要到下一次请求才重新对齐，此前一直按上一次请求计算；轮末的第二、第三遍据此继续折（真实运行里从 53 % 折到 3.9 %，目标约 16 %）。现在后面几遍用上一遍的总量减去已落地的部分。
- **插件页面：** DSH 插件页面现在按界面语言显示一份简短文档（Strata 做什么、核心功能和仓库链接；`docs/plugin-page.en.md`、`docs/plugin-page.zh-CN.md`，由 `locale/en.json` 和 `locale/zh.json` 里的 `meta.detail` 指定；其他语言回退到英文），不再显示带语言切换行的 GitHub README。
- **`/strata` 帮助和分节详情：** `/strata` 和 `/strata help` 列出子命令；`/strata status` 是简要状态；`/strata detail` 分为概览、分层、自动折叠、可折叠范围、缓存与成本、最近变化，各列对齐（DSH 把命令输出当纯文本显示，所以不用表格；网页里一个汉字比两个拉丁字符窄，所以中文标签用全角空格补齐）；`/strata detail full` 再列出每个可折叠范围里的每条消息。输出跟随界面语言（中文或英文，由输入框浮标上报）。缓存与成本一节新增按会话累计的账本：已落地变化的重新计费、回收量和按缓存价格估算的净节省。`/strata purge` 现在只说明会删除什么，`/strata purge confirm` 才删除。给模型的 `strata_status` 不变。
- **长轮次里也能收到提醒：** 折叠提醒不再只在有新用户消息的步骤出现；可折叠上下文每增长 50K 就会在任意步骤触发，没被理会的提醒在再增长 25K 后重新出现（上下文超过窗口 75 % 时为 12.5K）。
- **提醒步长和摘要等待量按真实 token 算：** 50K 的提醒步长（以及 ½ / ¼ 的重新提醒）和自动摘要之后的 50K 等待量，现在按服务商 token 计：本地估算除以本会话的「真实 ÷ 估算」比例（日志文本约 1.7）。`strata_status` 两个数都显示，例如 `next nudge at +50.0K (provider; ~29.2K local at ×1.71)`。
- **受保护尾部上限为窗口的 10 %：** 折叠从不碰最近三轮工具调用，但每轮并行读 5 个约 11K 的日志时，这段尾部约有 357K 服务商 token，自动摘要停在 39.7 %，到不了约 33 % 的目标。现在尾部取「最近三轮」和「约 10 % 窗口（服务商 token）」中较小的一个；最新一轮总是完整保留，边界不会把调用和结果拆开。`STRATA_PROTECTED_TAIL_PCT`（0.10；`0`/`off` 关闭）。`/strata detail` 会显示，例如 `Protected tail: last 1 of 3 tool rounds, ~56.1K local (~169.9K provider), capped at 10% of the window; the newest round alone is larger and stays whole.`
- **待定的模型折叠不再挡住自动摘要：** 模型的 `compress` 被代价检查推迟后会挂起最多三轮，期间自动摘要一次也不跑（Windows 测试停在 69.7 % 没有摘要）。现在挂起的折叠计入目标，自动摘要绕开它们的范围、和它们同批落地。超过自动折叠线（60 %，或两次提醒没回应时 50 %）时，挂起的模型折叠随这一批落地，不再等到 75 %；摘录按轮切分，这一批在目标附近停下；一次落地后仍高于目标时，同一个轮末再跑一轮；+50K 的等待只在「能折的都折了」之后才生效。`strata_status` 会写上一次轮末做了什么：`Automatic fold at last turn end: landed f4` / `skipped (…)` / `proposed f4, not landed (…)`。
- **自动摘要：** 模型连续两次没理会提醒且上下文超过 50 %（或不论提醒、超过 60 %）时，Strata 在轮次结束时从最旧的工作折起，直到可折叠部分约为（窗口 − 固定开销）的 30 %（固定开销是系统提示、工具定义等，`strata_status` 单独显示；下一次要再积累 50K 可折叠内容或超过 75 %），固定开销按比例校准（DSH 的总量跟随服务商的真实 token 数，层大小是 chars/4 估算，日志文本约差 1.65–1.71 倍；所以固定开销是工具和系统提示的估算价乘以这个比例，而不是总量减表面），写成不经模型的抽取式摘要（用户消息、助手文字开头、每个工具调用及其路径或命令和结果首行、错误）。它和模型折叠一样可以用 decompress 和 search_context 还原，走同一个成本检查，头部标记 `auto=1`；`strata_status` 单独统计，面板显示“自动折叠”，`strata/fold-landed` 事件带 `auto: true`。所有阈值都有 `STRATA_*` 设置，`STRATA_AUTO_FOLD=off` 关闭。

### v0.4.1 — DSH-Mem0 兼容 / DSH-Mem0 interop

0.4.0 打了标签但没有发布到 npm，所以 0.4.1 是 DSH-Mem0 兼容工作的第一个 npm 版本，包含 0.4.0 列出的全部内容：

- **运行时上下文快照**（比如 DSH-Mem0 召回的记忆）：surface 上只保留最新一份；更早的不存档、不切卡、不折叠，轮末换成 `[strata:dropped kind=runtime-context]` 占位（前缀已断时顺带清理，否则划算时清理，超过 75% 时直接清理）。见 `docs/interop-dsh-mem0.md`。
- 为上下文插件提供 **`strataBudget` 服务**（pressure / allowance / countTokens），并发出 `strata/fold-landed` 事件。
- **存档隐私修复：** 官方摘要替换掉的片段（`official-*.txt`）和卡片备份里不再保留运行时上下文快照，写进去的是占位。系统提示词也不再存档（每次请求都会重新生成），原位置只留一行 `[system prompt omitted]`，所以存档里不会有 DSH-Mem0 `<mem0-user-profile>` 之类内容的副本。
- **一次性存档清理：** 升级后第一次启动时，Strata 把 `<DSH_HOME>/strata/` 走一遍，清理 0.3.0 留下的已有存档文件：运行时上下文快照和 `<mem0-relevant-memories>` 块换成同样的占位，`<mem0-user-profile>` 块换成 `[strata:dropped kind=user-profile]`，官方摘要存档里的系统提示词段落换成 `[system prompt omitted]`。其他内容逐字节不变，文件权限保持 `0600`；写下标记文件（`.scrub-runtime-context-v2`）后不再重复执行，日志里记下清理了多少块。要整个删掉某个会话的存档，用 `/strata purge`。
- **`strata_status` 警告：** 请求的 `maxTokens` 加上余量超出上下文窗口、DSH 自动压缩因此不工作时，`strata_status` 第一行给出警告并写明模型。
- **输入框浮标：** 同一次轮末同时落地折叠、卡片和清理时，浮标播放折叠动画，而不是最后到达的那一个。

0.4.1 新增：

- **`strata_status` 警告：** DSH 官方摘要连续失败时（比如摘要上限太小，它默认等于 headroomTokens），`strata_status` 给出警告。

兼容性：与 dsh-mem0 0.3.0 搭配可以正常使用；`strataBudget` 召回预算和折叠记忆写入需要比 0.3.0 更新的 dsh-mem0。

验证：
- 54 个单元测试通过；`npm run check` 通过；打出的包不含本机路径。
- 与 DSH-Mem0 的联合测试（J1–J6：快照、折叠、记忆写入、缓存、预算、Web 浮标），DeepSeek V4.1 Flash：全部通过。

### v0.4.0 — 打了标签，未发布到 npm

- **运行时上下文快照**（比如 DSH-Mem0 召回的记忆）：surface 上只保留最新一份；更早的不存档、不切卡、不折叠，轮末换成 `[strata:dropped kind=runtime-context]` 占位（前缀已断时顺带清理，否则划算时清理，超过 75% 时直接清理）。见 `docs/interop-dsh-mem0.md`。
- 为上下文插件提供 **`strataBudget` 服务**（pressure / allowance / countTokens），并发出 `strata/fold-landed` 事件。
- **存档隐私修复：** 官方摘要替换掉的片段（`official-*.txt`）和卡片备份里不再保留运行时上下文快照，写进去的是占位。系统提示词也不再存档（每次请求都会重新生成），原位置只留一行 `[system prompt omitted]`，所以存档里不会有 DSH-Mem0 `<mem0-user-profile>` 之类内容的副本。
- **一次性存档清理：** 升级后第一次启动时，Strata 把 `<DSH_HOME>/strata/` 走一遍，清理 0.3.0 留下的已有存档文件：运行时上下文快照和 `<mem0-relevant-memories>` 块换成同样的占位，`<mem0-user-profile>` 块换成 `[strata:dropped kind=user-profile]`，官方摘要存档里的系统提示词段落换成 `[system prompt omitted]`。其他内容逐字节不变，文件权限保持 `0600`；写下标记文件（`.scrub-runtime-context-v2`）后不再重复执行，日志里记下清理了多少块。要整个删掉某个会话的存档，用 `/strata purge`。
- **`strata_status` 警告：** 请求的 `maxTokens` 加上余量超出上下文窗口、DSH 自动压缩因此不工作时，`strata_status` 第一行给出警告并写明模型。
- **输入框浮标：** 同一次轮末同时落地折叠、卡片和清理时，浮标播放折叠动画，而不是最后到达的那一个。

验证：
- 52 个单元测试通过；`npm run check` 通过；打出的包不含本机路径。
- 与 DSH-Mem0 的联合测试（J1–J6：快照、折叠、记忆写入、缓存、预算、Web 浮标），DeepSeek V4.1 Flash：全部通过。

### v0.3.0 — 以 `@lightcheng/dsh-strata` 发布到 npm

- 包名从 `@light-cheng/dsh-strata`（只在 GitHub 发布）改为 **`@lightcheng/dsh-strata`**，并发布到 npm：`dsh plugin --profile desktop add @lightcheng/dsh-strata`。
- 从 0.1–0.2 升级：请先卸载 `@light-cheng/dsh-strata`。旧包名还装着时，新包不接管并打出警告，DSH 原版压缩照常运行。
- 除此之外行为不变。

验证：
- 36 个单元测试和 4 个脚本测试通过；`npm run check` 通过；打出的包（35 个文件，97.7 kB）不含本机路径，所有相对引用都能解析。
- 真实 CLI，headless，DeepSeek V4.1 Flash：单独安装时接管；`dsh-live-compact` 不论装在前还是装在后、以及旧的 `@light-cheng/dsh-strata` 在场时，都让出并给出警告；强制引擎加载失败时，DSH 原版压缩运行。
- 真实模型评测：源文件删除后从存档召回 4/4；完整落地 T1 → T2 → T3 折叠链（7 个折叠），4/4 事实通过 `search_context` 找回。
- Web：各预设都没有未接管警告；插件页面显示 **Strata 分层上下文**，三个组件都有图标和名称；输入框浮标正常显示并跟随上下文占用。

### v0.2.2 — 显示名称

- 插件页面现在显示本地化的名称和描述，格式与 DSH-Mem0 一致：**Strata 分层上下文** / **Strata Context**，预设接管和上下文工具两个组件也有各自的名称（`locale/*.json`、`locale/gate/*.json`、`locale/tools/*.json`）。

验证：36 个单元测试通过；在安装后的副本里六个语言文件路径和三个图标路径都能解析。

### v0.2.1 — 组件图标

- 插件页面里 `strata-gate` 和 `strata-tools` 两个组件现在也显示 Strata 图标（`exports["./gate/icon"]`、`exports["./tools/icon"]`）。DSH 对子路径组件只从 `<specifier>/icon` 读图标。

验证：36 个单元测试通过；在安装后的副本里三个图标路径都能解析。

### v0.2.0 — 输入框状态浮标

- 新增输入框下方的状态浮标，和 dsh-mem0 的记忆地球仪并排：18px 的地层图标，沿用家族的黑白灰配色，平时显示上下文占用（`Strata 4.9%`）。某一层改动上下文时播放一次：L1 切卡片时一粒点落进最上层；L2 折叠或官方摘要时这粒点穿过每一层沉到底部；标签显示回收的 token（`折叠 T1 −23.3K`）。成功时浅蓝，失败时红；开启「减少动态效果」时不动；点击打开插件页面。
- 新增只读接口 `GET /dsh-strata/gui/status?session=…`，经过 DSH 的请求校验，只返回 token 数和事件类型。
- 插件页面现在显示 Strata 图标（`exports["./icon"]`）。

验证：36 个单元测试通过；`npm run check` 与 `npm pack` 通过；在临时 Web profile 里用 DeepSeek V4.1 Flash 真实落地了一个折叠，浮标播放动画、以浅蓝显示 `折叠 T1 −4.1K`，随后回到 `Strata 1.0%`。

### v0.1.1 — 修复 Web / Desktop 预设无法新建会话

- 修复：装上 Strata 后，DSH Desktop 和 Web 无法新建会话（`agent-preset/invalid: command-compact … waiting for compaction`）。每个 Agent 预设都隔离了自己的压缩服务，但接管检查看的是 cordis 的全局服务表，把相邻预设里 Strata 自己的引擎当成了别人的，于是让出，导致这个预设一个压缩服务都没有。现在检查只看自己作用域里的服务，每个预设都有自己的 Strata 引擎。
- 新的中英文 README、插件图标和本更新说明。

验证：34 个单元测试通过；`npm run check` 与 `npm pack` 通过；用 v0.1.0 能复现报错的临时 Web profile，换上新版后启动不再有未接管警告，可以正常新建会话。

### v0.1.0 — 首个公开版本

Strata Context 是 DeepSeek Harness 的分层、可还原上下文管理插件。

主要内容：

- L1 工具卡片：每轮结束时确定性地切尾部，不调模型，前缀逐字节不变。
- L2 三级模型折叠（`compress`）：当场校验，经过缓存代价估算后在本轮结束时一起落地。
- L3 本地存档：所有被替换的原文都先存档；`decompress` 逐级还原，`search_context` 做 BM25 检索并给出展开路径。
- `strata_status` 和 `/strata` 显示每层、每级的 token，可折叠范围和待落地的折叠。
- DSH 官方整段摘要仍然兜底；装了 `dsh-live-compact` 或 `billion-context` 时 Strata 不接管。

验证：32 个单元测试通过；用 DeepSeek V4.1 Flash 做的真实模型评测里，源文件删除后仍能从存档找回事实，并完整落地了 T1 → T2 → T3 一整条折叠链（设计文档 §11.10）。
