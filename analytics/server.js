const http = require("http");
const { spawnSync } = require("child_process");
const { detectQueryError, parseWranglerOutput, stripAnsi } = require("./server-parse.cjs");

const PORT = 8080;

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "POST" && req.url === "/query") {
    let body = "";
    for await (const chunk of req) body += chunk;

    try {
      const { sql, warehouse, token } = JSON.parse(body);
      if (!sql || !warehouse || !token) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "sql, warehouse, and token are required" }));
        return;
      }

      const proc = spawnSync("wrangler", ["r2", "sql", "query", warehouse, sql], {
        encoding: "utf-8",
        timeout: 30000,
        env: { ...process.env, NO_COLOR: "1", CLOUDFLARE_API_TOKEN: token },
      });
      if (proc.error) throw proc.error;

      const combined = `${proc.stdout || ""}\n${proc.stderr || ""}`;
      const queryError =
        proc.status !== 0 ? stripAnsi(combined).trim() : detectQueryError(combined);
      if (queryError) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: queryError }));
        return;
      }

      const rows = parseWranglerOutput(proc.stdout || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: rows }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message || String(err) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Analytics container listening on port ${PORT}`);
});
