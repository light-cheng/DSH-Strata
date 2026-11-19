// Same-origin, read-only HTTP route for the composer dock (v0.2.0).
//
// The Web client cannot call model-facing tools, so the dock polls this route.
// It is registered only when the composition serves a Web server, goes through
// the connection's request fence like every DSH route, and returns token
// counts and event kinds only: no message text, no archive paths.

import { readActivity } from "./activity.js";
import { takeover } from "./takeover.js";
import { setUiLanguage, translator } from "./command.js";
import { introText, plainStatus } from "./plain.js";
import { readSettings } from "./settings.js";
import { takeIntro } from "./state.js";

export const GUI_STATUS_PATH = "/dsh-strata/gui/status";
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/**
 * Status for the dock: activity, the plain-language line and hover text in
 * the UI language, and once per profile (first turn end with Strata in
 * charge) the first-run note. Nothing here reaches the model.
 * @param {string} sessionId
 * @param {string} version
 * @param {{ language?: string, intro?: () => boolean }} [options]
 */
export function statusPayload(sessionId, version, { language, intro = takeIntro } = {}) {
  const activity = readActivity(sessionId);
  const mode = takeover().mode;
  const payload = { version, takeover: mode, ...activity, now: Date.now() };
  try {
    const t = translator(language);
    const settings = readSettings();
    payload.plain = plainStatus(sessionId, t, { settings, now: payload.now });
    if (activity.usage && !["stock", "yielded", "unavailable"].includes(mode) && intro()) payload.intro = introText(t, settings);
  } catch {
    // The dock falls back to its own short label.
  }
  return payload;
}

export function registerGuiRoutes(ctx, version) {
  if (typeof ctx?.inject !== "function") return;
  ctx.inject(["webServer", "connection"], (child) => {
    if (!child?.webServer?.register) return;
    const handler = (req, res) => {
      const rejection = child.get("connection")?.requestRejection?.(req);
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end();
        return;
      }
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("allow", "GET");
        res.end();
        return;
      }
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const session = String(url.searchParams.get("session") || "");
        if (!SESSION_ID.test(session)) return sendJson(res, 400, { error: "session id required" });
        // The dock reports the active UI language so /strata can answer in it.
        if (url.searchParams.has("lang")) setUiLanguage(url.searchParams.get("lang"));
        sendJson(res, 200, statusPayload(session, version, { language: url.searchParams.get("lang") || undefined }));
      } catch {
        // Never leave the dock's poll hanging; it shows "status unavailable", not a compaction failure.
        try {
          if (!res.headersSent && !res.writableEnded) sendJson(res, 500, { error: "status unavailable" });
        } catch {}
      }
    };
    child.effect(() => child.webServer.register({ kind: "exact", path: GUI_STATUS_PATH, handler }), `dsh-strata: GET ${GUI_STATUS_PATH}`);
  });
}
