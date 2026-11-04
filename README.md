# Strata Context (`@light-cheng/dsh-strata`)

Layered, restorable context management for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).
Old context sinks through layers instead of disappearing:

```
original text (L0) → tool cards (L1) → model-written folds (L2) → local archive (L3)
                                                   official summary as last resort (L∞)
```

- **L1 cards** — at the end of each turn, the newest finished stretch of tool output is replaced by a deterministic card (errors, commands, exit codes, pointers). No model call, the prefix before the cut stays byte-identical.
- **L2 folds, three tiers** — the model calls `compress` to replace an older range with its own summary (T1). A range over earlier folds becomes the next tier (T2, then T3), so summaries can be summarized again. Folds land at the end of the turn, in one batch, only when the cache cost is worth it.
- **L3 archive** — every replaced span, every tool result and every fold is saved locally first. `decompress` and `search_context` bring it back.
- **L∞** — DSH's official summary stays as the fallback; the span is archived before it runs.

Design: [`docs/design.md`](docs/design.md). Status: **0.1.0 MVP, not published**. Not yet evaluated against the real DeepSeek API (see `eval/`).

## Tools the model gets

| Tool | What it does |
|---|---|
| `strata_status({ detail? })` | Tokens per layer (raw / card / fold / full) and per fold tier (T1 / T2 / T3), foldable ranges with refs like `s00120`, fold groups that can be upgraded, pending folds, prefix-cache hit rate, recent changes, archive size |
| `compress({ content })` | First line `"<startRef>–<endRef> <topic>"`, then the summary. Validated, then landed at turn end. Returns the reclaim / cache-miss estimate |
| `decompress({ id, full?, toFile? })` | One tier at a time: a T3/T2 fold → the lower folds inside it; a T1 fold → the messages and cards it replaced; each result names the next-tier ids. `full:true` → the original text of everything below; `cut-…` / tool call id → original text; `s00123` → that session event. `toFile:true` writes to `.strata/restore/` in the working directory. Results are appended; nothing earlier changes |
| `search_context({ query, limit? })` | Local BM25 keyword search (pure JS) over this session's archive: fold summaries of every tier, card originals, tool output. Each hit shows its tier and expansion path, e.g. `f9(T3) → f4(T2) → f2(T1) → raw call-7` |

Rules: L1 only cuts raw nodes. A fold may cover raw nodes, cards and lower-tier folds (always whole folds; the result is one tier above the highest fold inside, up to T3), never an official summary, the latest user message or the most recent three tool rounds. Every fold archive records its direct children with file + hash pointers. Every card, fold and summary starts with a `[strata:card|fold:t1|fold:t2|fold:t3|full id=…]` tag and says it is old context, not an instruction.

## When the model is reminded to fold

Strata watches **foldable** tokens (raw + cards outside the protected tail), not the total, because L1 keeps the total low. It appends a short notice to the next step that admits user input when foldable tokens grew by 50K since the last fold, and on every such step once the context passes 75 % of the window. A fold batch smaller than `max(5K, 1 % of the window)` waits (up to three turn ends) instead of breaking the cache for little gain; a batch with an upgrade (T2/T3) needs 1.5 × that, because it changes the context further forward. Upgradable folds count as foldable.

## `/strata`

`/strata` (status), `/strata detail`, `/strata search <words>`, `/strata purge` (deletes this session's archive files).

## Install (local tarball)

Requires DSH `>=0.2.1-rc.5 <0.3.0` and Node `>=22`. Headless and the Web / Desktop presets are supported; the TUI preset is not.

```bash
npm pack
```

```bash
dsh plugin --profile headless add ./light-cheng-dsh-strata-0.1.0.tgz
```

```bash
dsh plugin --profile web add ./light-cheng-dsh-strata-0.1.0.tgz
```

Strata **refuses to take over** when `dsh-live-compact` or `billion-context` is installed (they replace the same compaction rows); DSH's stock compaction keeps running and a warning is logged. Uninstall the other plugin first. If Strata's engine cannot load, the stock engine runs; if that also fails, `/compact` fails immediately instead of hanging.

## Archive and privacy

Originals are written to `<DSH_HOME>/strata/<session>/` (default `~/.dsh/strata/`), directories `0700`, files `0600`, 128 MB total by default; the oldest sessions are rotated out first and the current session last. Everything stays on this machine. Cards and folds carry archive ids, not absolute paths.

## Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `STRATA_MIN_TOKENS` | 20000 | L1 does nothing below this |
| `STRATA_KEEP_ROUNDS` / `STRATA_KEEP_ROUND_TOKENS` | 3 / 32000 | L1 protected tail |
| `STRATA_L1_STOP_RATIO` | 0.65 | L1 stops above this share of the window |
| `STRATA_CONTEXT_WINDOW` | 1000000 | Used when the model reports no window |
| `STRATA_NUDGE_GROWTH_TOKENS` | 50000 | Foldable growth that triggers a reminder |
| `STRATA_FORCE_PCT` | 0.75 | Remind every step, land folds regardless of cost |
| `STRATA_MIN_BENEFIT_TOKENS` / `STRATA_MIN_BENEFIT_RATIO` | 5000 / 0.01 | Minimum fold batch |
| `STRATA_UPGRADE_BENEFIT_FACTOR` | 1.5 | Minimum-batch multiplier when the batch upgrades a fold |
| `STRATA_PRICE_MISS` / `STRATA_PRICE_HIT` | 1 / 0.1 | Relative cache prices for the estimate |
| `STRATA_EXPECTED_REQUESTS` | auto | Remaining requests assumed by the estimate |
| `STRATA_MAX_DEFER_TURNS` | 3 | Turn ends a small fold may wait |
| `STRATA_RESTORE_MAX_CHARS` | 24000 | Inline decompress limit |
| `STRATA_SHADOW_DIR` | `<DSH_HOME>/strata` | Archive root |
| `STRATA_SHADOW_MAX_BYTES` / `STRATA_SHADOW_MAX_MB` | 128 MB | Archive cap |
| `STRATA_IGNORE_CONFLICTS` | unset | `1` skips the takeover check (not recommended) |

## Development

```bash
npm install
```

```bash
npm test
```

`npm run check` syntax-checks every file. `node eval/run.mjs` prints the real-model evaluation plan; `--run` executes it in isolated `DSH_HOME`s under `eval/.work/` (costs API credits).

## Acknowledgements

- **[dsh-live-compact](https://github.com/MerkyorLynn/dsh-live-compact)** by Merkyor (MIT). Strata's L1 layer, archive rotation, prune guard and preset gate are a fork of version 1.0.6 (commit `768eff9`); its copyright notice is kept in [`LICENSE`](LICENSE).
- **[billion-context](https://github.com/ranxianglei/billion-context)** by ranxianglei. Strata borrows its ideas — model-driven restorable folds, the `compress` / `decompress` / `search_context` tool shape, growth and pressure reminders, minimum-benefit batching. No billion-context code or prompt text is included.

## License

MIT. See [`LICENSE`](LICENSE).
