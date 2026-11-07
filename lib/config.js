// The settings page's Config (strata-gate row). Kept apart from settings.js so
// the engine never depends on schemastery loading. Labels and descriptions for
// the page live in client.js (zh / en); these descriptions document the keys.

import z from "@deepseek-ai/schemastery";
import { PAGE_DEFAULTS } from "./settings.js";

const percent = (fallback) => z.number().min(1).max(95).step(1).default(fallback);

/** Percentages are whole numbers of the context window. */
export const Config = z.object({
  mode: z.union([z.const("cost"), z.const("quality"), z.const("custom")]).default(PAGE_DEFAULTS.mode).description("cost | quality | custom"),
  autoFold: z.boolean().default(PAGE_DEFAULTS.autoFold).description("Automatic digests when nudges go unanswered"),
  nudge: z.boolean().default(PAGE_DEFAULTS.nudge).description("Remind the model to fold"),
  autoFoldPct: percent(PAGE_DEFAULTS.autoFoldPct).description("custom: auto-fold line, % of window"),
  autoFoldForcePct: percent(PAGE_DEFAULTS.autoFoldForcePct).description("custom: force line, % of window"),
  autoFoldTargetPct: percent(PAGE_DEFAULTS.autoFoldTargetPct).description("custom: fold target, % of the room after fixed overhead"),
  protectedTailPct: z.number().min(0).max(50).step(1).default(PAGE_DEFAULTS.protectedTailPct).description("custom: protected tail cap, % of window (0 = no cap)"),
  midTurnFold: z.boolean().default(PAGE_DEFAULTS.midTurnFold).description("custom: digests of earlier turns before a step"),
  midTurnCurrent: z.boolean().default(PAGE_DEFAULTS.midTurnCurrent).description("custom: also the current turn's finished rounds"),
  archiveDir: z.string().default(PAGE_DEFAULTS.archiveDir).description("Archive folder; empty = <DSH home>/strata"),
  archiveMaxMB: z.number().min(0).step(1).default(PAGE_DEFAULTS.archiveMaxMB).description("Warn above this archive size (MB); 0 = no warning; nothing is deleted"),
  archiveKeepDays: z.number().min(0).step(1).default(PAGE_DEFAULTS.archiveKeepDays).description("Delete archives of ended sessions after N days; 0 = never"),
}).i18n({
  zh: {
    mode: "模式：成本优先（默认）/ 质量优先 / 自定义。立即生效（下一次轮末或下一步）。",
    autoFold: "自动折叠：提醒没有回应时，Strata 自己把最早的内容折成摘要。立即生效。",
    nudge: "提醒模型折叠。关掉后只靠自动折叠；compress 工具仍可用。立即生效。",
    autoFoldPct: "仅自定义模式：自动折叠线（占窗口的百分比）。立即生效。",
    autoFoldForcePct: "仅自定义模式：强制折叠线。立即生效。",
    autoFoldTargetPct: "仅自定义模式：折叠目标（固定开销之外剩余空间的百分比）。立即生效。",
    protectedTailPct: "仅自定义模式：受保护末尾上限（占窗口的百分比，0 = 不设上限）。立即生效。",
    midTurnFold: "仅自定义模式：轮中摘要（每一步之前折叠更早的轮次）。立即生效。",
    midTurnCurrent: "仅自定义模式：轮中摘要也折叠当前轮已完成的工具轮次。立即生效。",
    archiveDir: "存档位置；留空 = <DSH 主目录>/strata。对新会话生效。",
    archiveMaxMB: "存档总大小超过这个值（MB）时提醒；0 = 不提醒。不会删除任何文件。立即生效。",
    archiveKeepDays: "自动删除超过 N 天未使用的已结束会话的存档；0 = 从不删除（默认）。立即生效。",
  },
  en: {
    mode: "Mode: cost first (default) / quality first / custom. Applies immediately (next turn end or step).",
    autoFold: "Automatic folds: when nudges go unanswered, Strata digests the oldest work itself. Applies immediately.",
    nudge: "Remind the model to fold. Off leaves folding to automatic digests; compress stays available. Applies immediately.",
    autoFoldPct: "Custom mode only: auto-fold line (% of the window). Applies immediately.",
    autoFoldForcePct: "Custom mode only: force line. Applies immediately.",
    autoFoldTargetPct: "Custom mode only: fold target (% of the room left after fixed overhead). Applies immediately.",
    protectedTailPct: "Custom mode only: protected tail cap (% of the window, 0 = no cap). Applies immediately.",
    midTurnFold: "Custom mode only: mid-turn digests (earlier turns, before a step). Applies immediately.",
    midTurnCurrent: "Custom mode only: mid-turn digests also cover the current turn's finished tool rounds. Applies immediately.",
    archiveDir: "Archive folder; empty = <DSH home>/strata. Applies to new sessions.",
    archiveMaxMB: "Warn when all archives together exceed this size (MB); 0 = never. Nothing is deleted. Applies immediately.",
    archiveKeepDays: "Delete archives of ended sessions unused for N days; 0 = never (default). Applies immediately.",
  },
}).volatile();

