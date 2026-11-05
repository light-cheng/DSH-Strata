// Same-origin, read-only HTTP route for the composer dock (v0.2.0).
//
// The Web client cannot call model-facing tools, so the dock polls this route.
// It is registered only when the composition serves a Web server, goes through
// the connection's request fence like every DSH route, and returns token
// counts and event kinds only: no message text, no archive paths.

import { readActivity } from "./activity.js";
import { takeover } from "./takeover.js";

export const GUI_STATUS_PATH = "/dsh-strata/gui/status";
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

export function statusPayload(sessionId, version) {
  const activity = readActivity(sessionId);
  return { version, takeover: takeover().mode, ...activity, now: Date.now() };
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
      const url = new URL(req.url ?? "/", "http://localhost");
      const session = String(url.searchParams.get("session") || "");
      if (!SESSION_ID.test(session)) return sendJson(res, 400, { error: "session id required" });
      sendJson(res, 200, statusPayload(session, version));
    };
    child.effect(() => child.webServer.register({ kind: "exact", path: GUI_STATUS_PATH, handler }), `dsh-strata: GET ${GUI_STATUS_PATH}`);
  });
}
