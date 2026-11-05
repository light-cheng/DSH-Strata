# Release notes

English is the default; the Chinese version follows below.

## English

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
