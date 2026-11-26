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
import { ackIntro, introPending, profileName } from "./state.js";

export const GUI_STATUS_PATH = "/dsh-strata/gui/status";
/** POST: the dock has shown the first-run note; only now is it recorded (lib/state.js). */
export const GUI_INTRO_ACK_PATH = "/dsh-strata/gui/intro-ack";
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/**
 * Status for the dock: activity, the plain-language line and hover text in
 * the UI language, and, until the dock acknowledges it (POST intro-ack), the
 * first-run note once a turn end ran with Strata in charge. Offering it
 * writes nothing. Nothing here reaches the model.
 * @param {string} sessionId
 * @param {string} version
 * @param {{ language?: string, intro?: () => boolean }} [options]
 */
export function statusPayload(sessionId, version, { language, intro = introPending } = {}) {
  const activity = readActivity(sessionId);
  const mode = takeover().mode;
  const payload = { version, takeover: mode, ...activity, now: Date.now() };
  try {
    const t = translator(language);
    const settings = readSettings();
    payload.plain = plainStatus(sessionId, t, { settings, now: payload.now });
    // Display only: the chip shows the full sentence all the time (STRATA_DOCK_DETAILS wins).
    payload.dockDetails = settings.dockDetails === true;
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
    // DSH's profileContext names the profile; read on each call, it is data-only.
    const profile = () => {
      let context;
      try {
        context = child.get?.("profileContext") ?? ctx.get?.("profileContext");
      } catch {
        context = undefined;
      }
      return profileName(process.env, process.argv, context);
    };
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
        sendJson(res, 200, statusPayload(session, version, { language: url.searchParams.get("lang") || undefined, intro: () => introPending({ profile: profile() }) }));
      } catch {
        // Never leave the dock's poll hanging; it shows "status unavailable", not a compaction failure.
        try {
          if (!res.headersSent && !res.writableEnded) sendJson(res, 500, { error: "status unavailable" });
        } catch {}
      }
    };
    child.effect(() => child.webServer.register({ kind: "exact", path: GUI_STATUS_PATH, handler }), `dsh-strata: GET ${GUI_STATUS_PATH}`);
    const ack = (req, res) => {
      const rejection = child.get("connection")?.requestRejection?.(req);
      if (rejection !== undefined) {
        res.statusCode = rejection;
        res.end();
        return;
      }
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.setHeader("allow", "POST");
        res.end();
        return;
      }
      try {
        // The request body is not needed: the profile is this process's own.
        req.resume?.();
        const result = ackIntro({ profile: profile() });
        if (!result.ok) child.logger?.warn?.(`strata: could not record the first-run note: ${result.error}`);
        sendJson(res, 200, { ok: result.ok });
      } catch {
        try {
          if (!res.headersSent && !res.writableEnded) sendJson(res, 500, { ok: false });
        } catch {}
      }
    };
    child.effect(() => child.webServer.register({ kind: "exact", path: GUI_INTRO_ACK_PATH, handler: ack }), `dsh-strata: POST ${GUI_INTRO_ACK_PATH}`);
  });
}
