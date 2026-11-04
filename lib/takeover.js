// Process-wide record of whether Strata took over ctx.compaction, so the
// tools row and /strata can explain a fallback.

/** @type {{ mode: "unknown" | "active" | "stock" | "unavailable" | "yielded", reason: string }} */
const state = { mode: "unknown", reason: "" };

export function setTakeover(mode, reason = "") {
  state.mode = mode;
  state.reason = reason;
}

export function takeover() {
  return { ...state };
}

export function describeTakeover(info = state) {
  switch (info.mode) {
    case "active": return "Strata is managing context.";
    case "stock": return `Strata did not take over; DSH stock compaction is running. ${info.reason}`;
    case "yielded": return `Strata did not take over; another plugin owns compaction. ${info.reason}`;
    case "unavailable": return `Strata did not take over and stock compaction could not load; /compact will fail fast. ${info.reason}`;
    default: return "Strata has not started in this process yet.";
  }
}
