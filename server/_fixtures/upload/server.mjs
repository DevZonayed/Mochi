import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function startFixtureServer() {
  const received = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/upload") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      const ct = req.headers["content-type"] || "";
      received.push({ contentType: ct, sizeBytes: body.length });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, sizeBytes: body.length, contentType: ct }));
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/pages/")) {
      const p = path.join(__dirname, req.url);
      try {
        const data = await fs.readFile(p);
        res.writeHead(200, { "content-type": "text/html" });
        res.end(data);
      } catch { res.writeHead(404); res.end("not found"); }
      return;
    }
    res.writeHead(404); res.end("?");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ port, received, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
