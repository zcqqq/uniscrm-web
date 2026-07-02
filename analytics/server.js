const http = require("http");
const { execSync } = require("child_process");

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

      const output = execSync(
        `wrangler r2 sql query "${warehouse}" "${sql.replace(/"/g, '\\"')}"`,
        { encoding: "utf-8", timeout: 30000, env: { ...process.env, NO_COLOR: "1", CLOUDFLARE_API_TOKEN: token } }
      );

      const rows = parseWranglerOutput(output);
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

function parseWranglerOutput(output) {
  const lines = output.trim().split("\n");
  // Table rows have │ on both sides: "│ value │"
  const tableLines = lines.filter((l) => {
    const stripped = l.replace(/\x1b\[[0-9;]*m/g, "").trim();
    return stripped.startsWith("│") && stripped.endsWith("│") && stripped.split("│").length >= 3;
  });
  if (tableLines.length < 2) return [];

  const parse = (line) => line.replace(/\x1b\[[0-9;]*m/g, "").split("│").slice(1, -1).map((c) => c.trim());

  const headers = parse(tableLines[0]);
  const rows = [];
  for (let i = 1; i < tableLines.length; i++) {
    const cells = parse(tableLines[i]);
    if (cells.length === headers.length) {
      const row = {};
      headers.forEach((h, idx) => {
        const val = cells[idx];
        row[h] = val === "" || val === "null" ? null : isNaN(val) ? val : Number(val);
      });
      rows.push(row);
    }
  }
  return rows;
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Analytics container listening on port ${PORT}`);
});
