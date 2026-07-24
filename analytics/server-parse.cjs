// Pure output-parsing helpers for the analytics query container.
// Kept free of node built-ins so unit tests can import them under the
// workers vitest pool (which cannot load node:http).

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// `wrangler r2 sql query` exits 0 even when the query fails (auth errors,
// missing table/column, SQL errors) and writes the error to stderr — so
// failures must be detected by content, never by exit code. Pass the
// combined stdout+stderr output.
function detectQueryError(output) {
  const cleaned = stripAnsi(output);
  if (!cleaned.includes("[ERROR]")) return null;
  const lines = cleaned.split("\n");
  const start = lines.findIndex((l) => l.includes("[ERROR]"));
  return lines
    .slice(start)
    .filter((l) => l.trim() && !l.includes("Logs were written"))
    .join("\n")
    .trim();
}

function parseWranglerOutput(output) {
  const lines = output.trim().split("\n");
  // Table rows have │ on both sides: "│ value │"
  const tableLines = lines.filter((l) => {
    const stripped = stripAnsi(l).trim();
    return stripped.startsWith("│") && stripped.endsWith("│") && stripped.split("│").length >= 3;
  });
  if (tableLines.length < 2) return [];

  const parse = (line) => stripAnsi(line).split("│").slice(1, -1).map((c) => c.trim());

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

module.exports = { stripAnsi, detectQueryError, parseWranglerOutput };
