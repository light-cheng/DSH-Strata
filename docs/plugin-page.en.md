# DSH Strata

Strata manages the context in layers: older tool output is cut into cards, older ranges are folded into summaries, and every original stays in a local archive, so nothing that is replaced is lost.

- **Tool cards (L1):** at each turn end, finished tool output becomes a deterministic card that keeps errors, commands and exit codes. No model call, and the prefix cache keeps hitting.
- **Folds in up to three tiers (L2):** the model summarizes older ranges with `compress`, and folds can be folded again (T1 → T2 → T3). A fold lands only when the tokens it saves outweigh the cache miss, or above 75% of the window.
- **Automatic digests:** when the model ignores the reminders, Strata folds the oldest work itself at turn end without a model call (above 50% of the window after two unanswered reminders, or above 60%), until the context is down to its fixed overhead plus about 30% of the room left.
- **Local archive (L3):** `decompress` restores any card or fold tier by tier, and `search_context` searches everything that was replaced.
- **Fallback:** DSH's official summary still runs when the layers are not enough; `strata_status` and `/strata` show the state.
- **Settings:** below on this page, pick cost first / quality first / custom, the reminder switch and archive options; changes apply without a restart. Read-only figures are in `/strata detail`.

Source, issues and release notes: https://github.com/light-cheng/dsh-strata
