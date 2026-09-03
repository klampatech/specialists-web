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

import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";

const PORT = parseInt(process.env.PORT || "14432", 10);
const ROOT = resolve(process.env.ROOT || "client/dist");
const HOST = process.env.HOST || "0.0.0.0";

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

function notFound(res, reason) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end(`not found: ${reason || ""}\n`);
}

function serverError(res, err) {
  res.writeHead(500, { "Content-Type": "text/plain" });
  res.end(`server error: ${err.message}\n`);
}

const server = await import("node:http").then((m) =>
  m.createServer((req, res) => {
    const ts = new Date().toISOString();
    try {
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
  }),
);

server.listen(PORT, HOST, () => {
  console.log(
    `[serve-static] listening on http://${HOST}:${PORT} root=${ROOT} (serving ${ROOT})`,
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