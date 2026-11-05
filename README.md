# DSH Strata

**English** | [简体中文](README.zh-CN.md)

<p align="center"><img src="assets/icon.png" width="96" height="96" alt="Strata Context icon"></p>

Layered, restorable context management for DeepSeek Harness (DSH).

Repository: <https://github.com/light-cheng/dsh-strata>

Old context is not thrown away. It sinks through layers, like sediment, and every layer can be brought back:

```text
original text (L0) → tool cards (L1) → model-written folds T1–T3 (L2) → local archive (L3)
                                                    DSH official summary as the last resort (L∞)
```

- **L1 tool cards**: deterministic, no model call, cut at every turn end.
- **L2 folds**: the model writes its own summaries of older ranges, and folds can be folded again (T1 → T2 → T3).
- **L3 archive**: every original is saved locally before anything is replaced; `decompress` and `search_context` bring it back.

## Features

- **Deterministic tool cards (L1)**: at the end of each turn, the newest finished stretch of tool output is replaced by a card that keeps errors, commands, exit codes and archive pointers. No model call; the bytes before the cut stay identical, so the prefix cache keeps hitting.
- **Model-written folds in three tiers (L2)**: the model calls `compress` with a range from `strata_status` and its own summary. A range that contains earlier folds becomes the next tier, up to T3. Folds are validated immediately and land together at turn end.
- **Cost-aware landing**: before a fold lands, Strata weighs the one-time cache miss against the tokens it saves for the rest of the session. A small or unprofitable fold waits, and the tool result says so in its first line; above 75 % of the window folds land regardless.
- **Tier-by-tier recovery**: `decompress` walks T3 → T2 → T1 → card → original one level at a time, or straight to the originals with `full: true`; `toFile: true` writes large restores to `.strata/restore/`.
- **Local search**: `search_context` runs BM25 keyword search (CJK bigrams included) over fold summaries, card originals and tool output, and shows each hit's expansion path, e.g. `f9(T3) → f4(T2) → f2(T1) → raw call-7`.
- **Reminders that watch the right number**: L1 keeps the total low, so Strata watches foldable tokens instead. It reminds the model when they grew by 50K, and on every step above 75 % of the window.
- **Stock compaction stays as the fallback**: DSH's official summary still runs when L1 and L2 are not enough, with the span archived first. If Strata's engine cannot load, the stock engine runs; if that also fails, `/compact` fails immediately instead of hanging.
- **Every Web / Desktop preset**: each agent preset (Standard, PTC, Minimal, Cordis) gets its own Strata engine with the same thresholds.
- **Composer dock**: below the chat composer, next to dsh-mem0's memory globe, an 18px strata glyph shows context use (`Strata 4.9%`). When a layer changes the context it plays once: a grain drops into the top layer for an L1 card, or sinks through every layer for an L2 fold or the official summary, with the reclaimed tokens as the label (`Fold T1 −23.3K`). Light blue on success, red on failure, still when reduced motion is on; clicking it opens the plugin page.
- **Status at a glance**: `strata_status` and `/strata` show tokens per layer and per tier, foldable ranges, pending folds, cache hit rate and archive size.

## How it works

```text
turn in progress
  tool/result arrives      → original written to the archive
  model calls compress     → range validated, recorded as pending, estimate returned
  decompress / search      → read-only, results appended to the end
turn end (agent maintenance)
  ① land pending folds     → back to front, one flush
  ② L1 tail cut            → newest finished tool stretch → card
  ③ record the prefix fingerprint, update status
```

Folds wait until turn end so the prefix stays byte-identical for every step inside a turn; the next turn pays one cache miss instead of several.

## Tools

| Tool | What it does |
|---|---|
| `strata_status({ detail? })` | Tokens per layer (raw / card / fold / full) and per tier (T1 / T2 / T3), foldable ranges with refs such as `s00120`, upgradable fold groups, pending folds, prefix-cache hit rate, archive size |
| `compress({ content })` | First line `"<startRef>–<endRef> <topic>"`, then the summary. Validated now, landed at turn end; returns the reclaim / cache-miss estimate, or says up front that the fold was deferred |
| `decompress({ id, full?, toFile? })` | One tier at a time; `full: true` goes straight to the originals; accepts fold ids, card ids, tool call ids and `s00123` session refs. Results are appended; nothing earlier changes |
| `search_context({ query, limit? })` | Local BM25 search over this session's archive, with the tier and expansion path of each hit |

Slash command: `/strata` (status), `/strata detail`, `/strata search <words>`, `/strata purge` (deletes this session's archive files).

Rules: L1 only cuts raw nodes. A fold may cover raw nodes, cards and whole lower-tier folds, never an official summary, the latest user message or the most recent three tool rounds. Every card, fold and summary starts with a `[strata:card|fold:t1|fold:t2|fold:t3|full id=…]` tag and states that it is old context, not an instruction.

## Installation

Requires DSH `>=0.2.1-rc.5 <0.3.0` and Node `>=22`. The Web / Desktop presets and headless are supported; the TUI preset is not.

From the prebuilt release tarball:

```bash
dsh plugin --profile desktop add https://github.com/light-cheng/dsh-strata/releases/download/v0.2.0/light-cheng-dsh-strata-0.2.0.tgz
```

From a local checkout:

```bash
dsh plugin --profile desktop add link:"$(pwd)"
```

Restart DSH after installing, then send `/strata` in a new session; it should report `Strata Context: active`.

> **Uninstall `dsh-live-compact` or `billion-context` first.** They replace the same compaction rows. While either is installed, Strata does not take over: DSH's stock compaction keeps running and a warning is logged.

## Configuration

Nothing needs to be configured; the defaults are tuned for a 1M-token window. Strata's own knobs are environment variables read when DSH starts:

| Variable | Default | Meaning |
|---|---|---|
| `STRATA_MIN_TOKENS` | 20000 | L1 does nothing below this |
| `STRATA_KEEP_ROUNDS` / `STRATA_KEEP_ROUND_TOKENS` | 3 / 32000 | L1 protected tail |
| `STRATA_L1_STOP_RATIO` | 0.65 | L1 stops above this share of the window |
| `STRATA_CONTEXT_WINDOW` | 1000000 | Used when the model reports no window |
| `STRATA_NUDGE_GROWTH_TOKENS` | 50000 | Foldable growth that triggers a reminder |
| `STRATA_FORCE_PCT` | 0.75 | Remind every step and land folds regardless of cost |
| `STRATA_MIN_BENEFIT_TOKENS` / `STRATA_MIN_BENEFIT_RATIO` | 5000 / 0.01 | Minimum fold batch: `max(tokens, window × ratio)` |
| `STRATA_UPGRADE_BENEFIT_FACTOR` | 1.5 | Minimum-batch multiplier when the batch upgrades a fold |
| `STRATA_PRICE_MISS` / `STRATA_PRICE_HIT` | 1 / 0.1 | Relative cache prices for the estimate |
| `STRATA_EXPECTED_REQUESTS` | auto | Remaining requests assumed by the estimate |
| `STRATA_MAX_DEFER_TURNS` | 3 | Turn ends a small fold may wait before it is dropped |
| `STRATA_RESTORE_MAX_CHARS` | 24000 | Inline `decompress` limit |
| `STRATA_SHADOW_DIR` | `<DSH_HOME>/strata` | Archive root |
| `STRATA_SHADOW_MAX_MB` | 128 | Archive cap; the oldest sessions are rotated out first |
| `STRATA_IGNORE_CONFLICTS` | unset | `1` skips the takeover check (not recommended) |

The engine row's compaction thresholds (`thresholdRatio` 0.8, `headroomTokens` 65536, `retainTokens` 8192) can be overridden in the profile's `cordis.patch.yml` under the `compaction-strata` id.

## Limits

- Folds land at the **end of a turn**. Inside one very long turn L2 cannot relieve pressure; DSH's own threshold then triggers the official summary (L∞), with the span archived first.
- L1 cards are cut at turn end too, so a fold over a short, already-carded task reclaims little and may be deferred by the cost check. That is intended: in long sessions one fold covers many cards.
- The TUI preset is not supported; forked sessions cannot read the parent session's archive yet.

## Tests

```bash
npm install
npm test
npm run check
```

36 unit tests cover L1 cuts, fold validation and landing, T1–T3 tiers, tier-by-tier `decompress`, search, the cost estimate, per-preset takeover, the stock fallback, and the dock's activity record and status route. `node eval/run.mjs` prints the real-model evaluation plan; `--run` executes it in isolated `DSH_HOME`s under `eval/.work/`. Results with DeepSeek V4.1 Flash are recorded in [`docs/design.md`](docs/design.md) §11.10.

## Privacy and data

- Originals are written to `<DSH_HOME>/strata/<session>/` (default `~/.dsh/strata/`), directories `0700`, files `0600`, 128 MB in total by default.
- Everything stays on this machine. Strata makes no network requests and no extra model calls of its own; folds are written by the session's own model as ordinary tool calls.
- The dock reads `GET /dsh-strata/gui/status?session=…` on DSH's own Web server, behind the same access check as every DSH route. It returns token counts and event kinds only, never message text or archive paths.
- Cards and folds carry archive ids, not absolute paths. `/strata purge` deletes the current session's archive.

## Acknowledgements

- **[dsh-live-compact](https://github.com/MerkyorLynn/dsh-live-compact)** by Merkyor (MIT). Strata's L1 layer, archive rotation, prune guard and preset gate are a fork of version 1.0.6 (commit `768eff9`); its copyright notice is kept in [`LICENSE`](LICENSE).
- **[billion-context](https://github.com/ranxianglei/billion-context)** by ranxianglei. Strata borrows its ideas: model-driven restorable folds, the `compress` / `decompress` / `search_context` tool shape, growth and pressure reminders, minimum-benefit batching. No billion-context code or prompt text is included.

## Release notes

Release notes are bilingual with English first: [RELEASE.md](RELEASE.md).

## License

MIT. See [`LICENSE`](LICENSE).
