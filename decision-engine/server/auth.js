// Optional HTTP Basic auth for the whole dashboard (API, static UI, WebSocket).
// Enabled when DASHBOARD_PASSWORD is set (DASHBOARD_USER defaults to "admin"). Use it whenever the
// dashboard is reachable from the internet (e.g. on a VPS); put TLS (Caddy/nginx) in front if you can.
const crypto = require("crypto");

const USER = process.env.DASHBOARD_USER || "admin";
const PASS = process.env.DASHBOARD_PASSWORD || "";
const enabled = () => PASS.length > 0;

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function checkHeader(h) {
  if (!enabled()) return true;
  const m = /^Basic\s+(.+)$/i.exec(h || "");
  if (!m) return false;
  const [u, ...rest] = Buffer.from(m[1], "base64").toString("utf8").split(":");
  return safeEq(u, USER) && safeEq(rest.join(":"), PASS);
}

function middleware(req, res, next) {
  if (!enabled() || req.path === "/api/health/ping" || checkHeader(req.headers.authorization)) return next();
  res.set("WWW-Authenticate", 'Basic realm="Decision Engine", charset="UTF-8"').status(401).send("Authentication required");
}

// ws verifyClient: browsers resend cached Basic credentials on same-origin WebSocket upgrades.
const verifyWs = (info) => checkHeader(info.req.headers.authorization);

module.exports = { middleware, verifyWs, enabled, checkHeader };
