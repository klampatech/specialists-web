#!/usr/bin/env node
// Tiny static-file server for the production game client.
//
// Purpose: serve `client/dist/` over Tailscale Funnel on a separate port
// (default 14432) so the play-test entry point
// `https://m5.tail1b3795.ts.net:14432/` returns `index.html` and the
// asset bundle. The wire server (specialists-server) lives on a
// different Funnel-forwarded port (14433 for WebTransport, 14435 for
// WSS fallback).
//
// Why this is separate from the wire server:
//   - Funnel forwards one host:port per endpoint; we'd need a separate
//     Funnel rule for a second port anyway.
//   - The static bundle is a different lifecycle from the wire server
//     (rebuilt on UI changes vs on game-logic changes).
//   - In the cloud endgame this is replaced by a CDN in front of a
//     static bucket; same topology, different host.
//
// Why a hand-rolled http server (no express/serve-static/etc.):
//   - The dependency surface for serving `client/dist/` is 4
//     Content-Types + 1 range-request check. express adds 200+ deps
//     and a 15MB node_modules footprint for a 50-line replacement.
//
// Usage:
//   PORT=14432 ROOT=client/dist node tools/serve-static.mjs
//
// Health:
//   GET /health → 200 "ok" (matches specialists-server's /health endpoint
//   so the deploy script's health-check shape stays uniform)
//
// Content-Type map: only the MIME types we actually ship in
// client/dist/. Add more if the build starts emitting new extensions.

import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { extname, join, normalize, resolve } from "node:path";

const PORT = parseInt(process.env.PORT || "14432", 10);
const ROOT = resolve(process.env.ROOT || "client/dist");
const HOST = process.env.HOST || "0.0.0.0";

// Optional TLS — set TLS_CERT + TLS_KEY env vars to enable HTTPS.
// The handler is identical for http and https; only the server
// instance differs. Used by Hetzner / cloud deployments where
// there's no Tailscale Funnel terminating TLS in front of the
// static port — the static port must be HTTPS so the lobby page
// can use WSS / WebTransport without mixed-content blocks. In dev
// (vite on 5174 + m5 Funnel) leave these unset for plain HTTP.
const TLS_CERT = process.env.TLS_CERT; // absolute path to PEM cert
const TLS_KEY = process.env.TLS_KEY; // absolute path to PEM key
const TLS_ENABLED = !!(TLS_CERT && TLS_KEY);

// Where the wire server's matchmaker HTTP listener is reachable.
// Default matches the deploy-prod.sh convention: matchmaker on 8084
// (vaultwarden's docker-proxy holds :8080; llama-server holds :8081).
const MATCHMAKER_URL =
  process.env.MATCHMAKER_URL || "http://127.0.0.1:8084";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function safeJoin(rootDir, requestedPath) {
  // Reject any path that escapes `rootDir` after normalization.
  // Mirrors the express.static defense.
  const cleaned = normalize(requestedPath).replace(/^(\.\.[\/\\])+/, "");
  const full = join(rootDir, cleaned);
  const normalizedRoot = normalize(rootDir) + (rootDir.endsWith("/") ? "" : "/");
  if (!normalize(full).startsWith(normalizedRoot)) return null;
  return full;
}

/**
 * Proxy a /rooms* request to the wire server's matchmaker HTTP listener.
 * The lobby client derives its matchmaker origin from window.location.origin
 * (which is the static server's port), so we must forward /rooms* here
 * rather than tell the client to use a different origin.
 *
 * Why this exists instead of running the matchmaker on the static port:
 * Funnel forwards single host:port per endpoint, and the matchmaker's
 * POST/GET handlers are plain HTTP while the wire transport is HTTP/3.
 * Funnel re-encrypts the static-port's TLS, so we can't multiplex
 * matchmaker + static on the same encrypted port without an HTTP/3-aware
 * static server. Proxying is the simplest path that keeps the lobby
 * URL the client expects (same origin).
 */
async function proxyToMatchmaker(req, res, ts) {
  const targetUrl = `${MATCHMAKER_URL}${req.url}`;
  // Build a fetch init that forwards method + headers + body.
  const init = {
    method: req.method,
    headers: { ...req.headers, host: undefined },
  };
  // Re-set Host so the matchmaker's log shows its own host header,
  // not ours. (Setting host: undefined drops the inbound Host header.)
  if (init.headers && init.headers.host !== undefined) {
    delete init.headers.host;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Body forwarding for POST /rooms (Content-Length: 0 in the
    // observed case, but forward arbitrary bodies to be safe).
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    init.body = Buffer.concat(chunks);
  }

  let upstream;
  try {
    upstream = await fetch(targetUrl, init);
  } catch (err) {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`matchmaker upstream error: ${err.message}\n`);
    console.log(`[${ts}] 502 ${req.method} ${req.url} → ${targetUrl} (${err.message})`);
    return;
  }

  const buf = Buffer.from(await upstream.arrayBuffer());
  // Node's fetch returns a Headers object — spreading it gives an object
  // with all headers as enumerable properties, but case-folding can be
  // inconsistent across Node versions. Use the Headers iterator explicitly
  // to be safe.
  const headers = {};
  for (const [k, v] of upstream.headers) {
    // Skip hop-by-hop / length-affecting headers (Node sets the right
    // Content-Length when we call res.end(buf) with a Buffer).
    if (k.toLowerCase() === "content-encoding") continue;
    if (k.toLowerCase() === "transfer-encoding") continue;
    headers[k] = v;
  }

  // The matchmaker uses `peer.ip()` to build `ws_url`/`wss_url` in the
  // POST /rooms response. With our proxy in front, `peer.ip()` is always
  // 127.0.0.1 (the proxy's outbound side). The lobby client uses
  // `ws_url` to know where the wire server is — getting `127.0.0.1`
  // would make the browser try to connect to the wrong host (the
  // tailnet IP is needed for cross-device play-testing).
  //
  // Fix: substitute the proxy's own Host header (which carries the
  // client's original Host, including Tailscale DNS) into the response
  // JSON. Only the `ws_url`/`wss_url` keys are affected — room id and
  // player count pass through unchanged. If rewriting fails, we still
  // return the original response.
  let body = buf;
  const contentType = headers["content-type"] || "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(buf.toString("utf8"));
      const proxyHost = (req.headers["x-forwarded-host"] ||
        req.headers.host ||
        "").split(":")[0];
      if (proxyHost && parsed.ws_url) {
        parsed.ws_url = parsed.ws_url.replace(
          /^ws:\/\/[^:/]+/,
          `ws://${proxyHost}`,
        );
      }
      if (proxyHost && parsed.wss_url) {
        parsed.wss_url = parsed.wss_url.replace(
          /^wss:\/\/[^:/]+/,
          `wss://${proxyHost}`,
        );
      }
      body = Buffer.from(JSON.stringify(parsed), "utf8");
      if (headers["content-length"]) {
        headers["content-length"] = String(body.length);
      }
    } catch {
      // Non-JSON or malformed — pass through unchanged
    }
  }

  res.writeHead(upstream.status, headers);
  res.end(body);
  console.log(
    `[${ts}] ${upstream.status} ${req.method} ${req.url} → ${targetUrl} (${body.length} bytes)`,
  );
}

function notFound(res, reason) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end(`not found: ${reason || ""}\n`);
}

function serverError(res, err) {
  res.writeHead(500, { "Content-Type": "text/plain" });
  res.end(`server error: ${err.message}\n`);
}

// PR-4 Hetzner staging — build the request handler on an HTTP server
// (noListen so we don't double-bind), then pass it to either http
// or https. The TLS_CERT/TLS_KEY env vars pick which listener we
// expose; without them, behavior is identical to before this PR.
const handler = (req, res) => {
  const ts = new Date().toISOString();
  try {
      // Proxy routes accept GET/HEAD (for /rooms/<id>) AND POST
      // (for /rooms creation). Other methods on /rooms* are 405.
      if (
        req.url === "/rooms" ||
        req.url.startsWith("/rooms/")
      ) {
        if (
          req.method !== "GET" &&
          req.method !== "HEAD" &&
          req.method !== "POST"
        ) {
          res.writeHead(405, { "Content-Type": "text/plain" });
          res.end("method not allowed\n");
          return;
        }
        proxyToMatchmaker(req, res, ts);
        return;
      }

      // Static-file routes accept only GET/HEAD.
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        res.end("method not allowed\n");
        return;
      }

      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok\n");
        return;
      }

      // (Proxy check moved above — see top of handler.)

      // Strip query string for path resolution
      const urlNoQuery = req.url.split("?")[0] || "/";
      // SPA fallback — anything that's not a file path serves index.html.
      // (We don't ship a multi-route SPA today, but this is the future-proof
      // shape if the client becomes a real router.)
      const looksLikeFile = /\.[a-z0-9]+$/i.test(urlNoQuery);

      // Root path "/" → serve index.html directly without stat-ing the
      // directory first (which always returns isDirectory=true and 404s).
      if (urlNoQuery === "/" || urlNoQuery === "") {
        const indexPath = join(ROOT, "index.html");
        try {
          const indexStat = statSync(indexPath);
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": indexStat.size,
          });
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          createReadStream(indexPath).pipe(res);
          console.log(`[${ts}] 200 ${req.method} ${req.url} → index.html (root)`);
          return;
        } catch {
          notFound(res, "no index.html");
          console.log(`[${ts}] 404 ${req.method} ${req.url}`);
          return;
        }
      }

      const requestedPath = looksLikeFile ? urlNoQuery : "/";

      const fullPath = safeJoin(ROOT, requestedPath);
      if (!fullPath) {
        notFound(res, "path escapes root");
        console.log(`[${ts}] 404 ${req.method} ${req.url} (path-escape)`);
        return;
      }

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        if (looksLikeFile) {
          notFound(res, "no such file");
          console.log(`[${ts}] 404 ${req.method} ${req.url}`);
        } else {
          // SPA fallback to index.html for unknown extension-less paths
          const indexPath = join(ROOT, "index.html");
          try {
            const indexStat = statSync(indexPath);
            const stream = createReadStream(indexPath);
            res.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Length": indexStat.size,
            });
            if (req.method === "HEAD") {
              res.end();
              return;
            }
            stream.pipe(res);
            console.log(`[${ts}] 200 ${req.method} ${req.url} → index.html`);
            return;
          } catch {
            notFound(res, "no index.html");
            console.log(`[${ts}] 404 ${req.method} ${req.url}`);
          }
        }
        return;
      }

      if (stat.isDirectory()) {
        notFound(res, "is directory");
        console.log(`[${ts}] 404 ${req.method} ${req.url}`);
        return;
      }

      const ext = extname(fullPath).toLowerCase();
      const contentType = MIME[ext] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stat.size,
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(fullPath).pipe(res);
      console.log(`[${ts}] 200 ${req.method} ${req.url}`);
    } catch (err) {
      serverError(res, err);
      console.error(`[${ts}] 500 ${req.method} ${req.url}: ${err.message}`);
    }
};

const server = TLS_ENABLED
  ? createHttpsServer(
      { cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) },
      handler,
    )
  : createHttpServer(handler);

server.listen(PORT, HOST, () => {
  const scheme = TLS_ENABLED ? "https" : "http";
  console.log(
    `[serve-static] listening on ${scheme}://${HOST}:${PORT} root=${ROOT} (serving ${ROOT})${TLS_ENABLED ? ` cert=${TLS_CERT}` : ""}`,
  );
});

process.on("SIGINT", () => {
  console.log("[serve-static] SIGINT — shutting down");
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  console.log("[serve-static] SIGTERM — shutting down");
  server.close(() => process.exit(0));
});