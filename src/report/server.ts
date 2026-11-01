import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { appendOp, isJudgment, readJudgments } from "../judge/store.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json",
  ".cast": "text/plain; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
};

/** Serves the report and persists judgments to judgments/judgments.jsonl. */
export function serve(reportDir: string, port: number, host = "127.0.0.1"): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (code: number, body: string, type = "application/json") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    try {
      if (url.pathname === "/api/judgments") {
        if (req.method === "GET") return send(200, JSON.stringify(readJudgments()));
        if (req.method === "POST") {
          let body = "";
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 1_000_000) return send(413, '{"error":"too large"}');
          }
          const msg = JSON.parse(body) as { op: string; judgment?: unknown; id?: string };
          if (msg.op === "add" && isJudgment(msg.judgment)) appendOp({ op: "add", judgment: msg.judgment });
          else if (msg.op === "del" && typeof msg.id === "string") appendOp({ op: "del", id: msg.id });
          else return send(400, '{"error":"bad request"}');
          return send(200, '{"ok":true}');
        }
        return send(405, '{"error":"method not allowed"}');
      }
      const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const file = path.resolve(reportDir, "." + rel);
      if (!file.startsWith(path.resolve(reportDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        return send(404, "not found", "text/plain");
      }
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      send(500, JSON.stringify({ error: String(e) }));
    }
  });
  server.listen(port, host);
  return server;
}
