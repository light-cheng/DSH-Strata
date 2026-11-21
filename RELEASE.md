# Release notes

English is the default; the Chinese version follows below.

## English

### v0.5.0 — 2026-11-21

0.5.0 makes Strata easier to set up and easier to read: a settings page instead of environment variables, a status line in plain words, and checks that keep Strata from tidying up when it would not pay.

Highlights:

- **Settings page:** DSH's plugin page for Strata Context now has a **Strata settings** section (Chinese / English). Pick a mode: **cost first** (the default; folds at turn end once context passes 60 % of the window, or 50 % after the model ignored two reminders, down to about 30 %), **quality first** (25 / 35 / 15 %, and it also folds inside long turns) or **custom** (set the lines yourself). You can also switch automatic folds and fold reminders, and set the archive folder, an archive size warning and how many days ended sessions' archives are kept. Every field says when it applies; changes take effect at the next turn end or step without a restart, and **Restore defaults** clears them. `STRATA_*` environment variables still win over the page.
- **A rejection is not a failure:** when a check refuses a card or fold (the summary is not smaller, the range changed, or it would not pay back), the dock no longer turns red. `/strata detail` shows it on a neutral **Last rejection** line; only real errors show as **Last failure**.
- **Status line in plain words:** the dock under the composer shows one line: what Strata has saved this session, when the saving starts, or the current context use. "Saved" is the net saving: reclaimed tokens minus what re-sending the context cost. The hover card says in plain words when the next tidy-up comes (for example, after about 50K more), shows ids as ranges (`f180–f173 (8 folds)`), and the payback line names the factor used to convert Strata's local estimate into the provider's tokens (`converted at ×1.7`). The first time Strata works in a profile, a note above the dock says so once.
- **Forward slashes in paths:** paths the model and you read (`decompress` to a file, the archive folder in `/strata detail`, warnings) use `/` on every platform, Windows included.
- **Three-platform CI and automatic npm releases:** tests run on Ubuntu, macOS and Windows with Node 22 and 24. Publishing a GitHub release publishes the package to npm with trusted publishing and provenance: prereleases go to the `next` tag, normal releases to `latest`.

Also in this release:

- **Minimum gain:** a card or fold lands only if it reclaims at least 2K tokens and pays back its cache miss within at most 100 requests, so a small card no longer re-bills tens of thousands of tokens. L1 skips short spans whose card would not be smaller, and a span a check refused is not tried again until its text changes.
- **One row per tidy-up:** each tidy-up shows as one "Context compacted" row in the chat, with a readable line, instead of one row per fold.
- **Ledger in provider tokens:** the cost ledger in `/strata detail` (re-billed, reclaimed, net saving, payback) counts the provider's tokens, not local estimates.
- **Automatic digests:** cut per tool round and stopping near the target instead of folding far past it; a pending model fold no longer blocks them; the protected tail is capped at about 10 % of the window. Fold reminders also reach the model inside long turns.
- **Quality first, inside the turn:** digests can cover the current turn's finished tool rounds, with a note that those calls already ran; on a 1M window peaks stayed near 35 % at the same cost per request.
- **Small windows:** when DSH's own summary would fire below Strata's lines, the lines move 5 points below it.
- **`/strata`:** help, a short `status`, a sectioned `detail` in the UI language that starts with the version (package version, commit, code hash); `purge` and `purge ended` delete only after `confirm`.
- **Plugin page:** a short document in the UI language instead of the GitHub README.

Verification:
- 163 unit tests pass on Ubuntu, macOS and Windows (Node 22 / 24); `npm run check` passes.
- The acceptance checklist `docs/acceptance-0.5.md` passed on Windows and macOS.

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

### v0.5.0 — 2026-11-21

0.5.0 让 Strata 更好设置、更好看懂：用设置页代替环境变量，状态栏改成白话，并且在不划算时不再整理上下文。

重点：

- **设置页：** DSH 插件页里 Strata 分层上下文的详情下面新增 **Strata 设置**（中英文）。可以选模式：**成本优先**（默认；上下文超过窗口的 60 % 时在轮末折叠，模型连续两次没理会提醒时是 50 %，折到约 30 %）、**质量优先**（25 / 35 / 15 %，长轮次中途也会折叠）或 **自定义**（各条线自己定）。还可以开关自动折叠和提醒模型折叠，设置存档位置、存档大小提醒上限和已结束会话的存档保留天数。每一项都写明何时生效；改动在下一次轮末或下一步生效，不用重启；**恢复默认** 清掉全部值。`STRATA_*` 环境变量仍然优先于设置页。
- **拒收不算失败：** 卡片或折叠被校验拒收（摘要不比原文小、范围已变、不能回本）时，状态栏不再变红。`/strata detail` 单独显示一行中性的 **上次拒收**；只有真正的错误才显示为 **上次失败**。
- **状态栏白话行和悬停提示：** 输入框下面的状态栏只显示一行：本会话已省多少、什么时候开始省，或者当前上下文用量。「已省」按净节省算：回收的 token 减去重新发送上下文的花费。悬停提示用白话说下一次整理什么时候来（比如「再增加约 50K 后」），ids 显示成范围（比如 `f180–f173`），回本一行注明把 Strata 本地估算换算成服务商 token 时用的倍数（`按 ×1.7 换算`）。Strata 第一次在某个 profile 里工作时，状态栏上方会提示一次。
- **路径统一用正斜杠：** 模型和你看到的路径（`decompress` 写出的文件、`/strata detail` 里的存档位置、警告）在所有平台上都用 `/`，Windows 也一样。
- **三平台 CI，自动发布到 npm：** 测试在 Ubuntu、macOS、Windows 上用 Node 22 和 24 运行。在 GitHub 上发布 release 后，会通过 trusted publishing 带 provenance 自动发布到 npm：预发布版走 `next`，正式版走 `latest`。

其他改动：

- **最小收益：** 卡片或折叠至少要回收 2K token、并在最多 100 次请求内收回缓存未命中的成本才落地，小卡片不再重新计费几万 token。L1 跳过切成卡片也不会变小的小段；被校验拒收的段在内容变化前不再反复尝试。
- **压缩标记一次一行：** 每次整理在对话里只显示一行「上下文已压缩」，内容是人能读懂的一句话，不再每个折叠一行。
- **服务商口径的账本：** `/strata detail` 里的成本账本（重新计费、回收量、净节省、回本）按服务商 token 计，不再用本地估算。
- **自动摘录：** 按工具轮切分，在目标附近停下，不再远远折过目标；挂起的模型折叠不再挡住它；受保护尾部上限约为窗口的 10 %。长轮次里也能收到折叠提醒。
- **质量优先模式的轮中摘录：** 可以覆盖当前轮已完成的工具轮，并告诉模型这些调用已经执行过；1M 窗口实测峰值保持在约 35 %，每请求成本不变。
- **小窗口：** DSH 官方摘要的触发线低于 Strata 的线时，Strata 的线自动降到它下面 5 个百分点。
- **`/strata`：** 新增帮助、简要的 `status`、按界面语言分节的 `detail`（第一行是版本：包版本、提交号、代码哈希）；`purge` 和 `purge ended` 要再发 `confirm` 才删除。
- **插件页面：** 按界面语言显示一份简短文档，不再显示 GitHub README。

验证：
- 163 个单元测试在 Ubuntu、macOS、Windows（Node 22 / 24）上通过；`npm run check` 通过。
- 验收清单 `docs/acceptance-0.5.md` 在 Windows 和 macOS 上通过。

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
