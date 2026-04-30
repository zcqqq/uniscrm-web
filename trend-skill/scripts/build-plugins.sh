#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PACKAGE_NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/package.json','utf8')).name)")
VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/package.json','utf8')).version)")
SKILL_NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/skill/manifest.json','utf8')).name)")
DESCRIPTION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/skill/manifest.json','utf8')).description)")
AUTHOR=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$ROOT/skill/manifest.json','utf8')).author)")

MCP_URL="${MCP_URL:-https://trend-skill-dev.zhengchao-qqqqq.workers.dev/mcp}"

echo "Building plugins: $PACKAGE_NAME v$VERSION"
echo "  Skill: $SKILL_NAME"
echo "  MCP URL: $MCP_URL"

# ── Claude Code Plugin ──────────────────────────────────
CC_DIR="${CC_DIR:-/Users/zc/Documents/Code/uniscrm-plugin}"
find "$CC_DIR" -mindepth 1 -not -path "$CC_DIR/.git" -not -path "$CC_DIR/.git/*" -delete 2>/dev/null || true
mkdir -p "$CC_DIR/.claude-plugin" "$CC_DIR/skills/$SKILL_NAME"

cat > "$CC_DIR/.claude-plugin/plugin.json" <<EOJSON
{
  "name": "$PACKAGE_NAME",
  "version": "$VERSION",
  "description": "$DESCRIPTION",
  "author": {
    "name": "$AUTHOR"
  }
}
EOJSON

cat > "$CC_DIR/.claude-plugin/marketplace.json" <<EOJSON
{
  "name": "uniscrm-plugin",
  "description": "UnisCRM plugins for social media trend aggregation",
  "owner": {
    "name": "$AUTHOR"
  },
  "plugins": [
    {
      "name": "$PACKAGE_NAME",
      "source": "./",
      "description": "$DESCRIPTION",
      "version": "$VERSION"
    }
  ]
}
EOJSON

cat > "$CC_DIR/.mcp.json" <<EOJSON
{
  "mcpServers": {
    "$PACKAGE_NAME": {
      "type": "http",
      "url": "$MCP_URL"
    }
  }
}
EOJSON

{
  printf -- '---\nname: %s\ndescription: %s\n---\n' "$SKILL_NAME" "$DESCRIPTION"
  sed '1{/^---$/!q;};1,/^---$/d' "$ROOT/skill/SKILL.md"
} > "$CC_DIR/skills/$SKILL_NAME/SKILL.md"

cat > "$CC_DIR/README.md" <<EOMD
# $PACKAGE_NAME — Claude Code Plugin

$DESCRIPTION

## Installation

\`\`\`
/install-plugin $PACKAGE_NAME
\`\`\`

Or from a local path:

\`\`\`
/install-plugin /path/to/$PACKAGE_NAME/dist/claude-code-plugin
\`\`\`

## MCP Tools

This plugin registers a remote MCP server at \`$MCP_URL\` with 6 tools:

| Tool | Auth Required | Description |
|------|:---:|-------------|
| \`list_platforms\` | No | List active trend platforms |
| \`trending_now\` | No | Get current trending topics |
| \`search_trends\` | Yes | Semantic search across trends |
| \`query_trends\` | Yes | Query trends with metadata filters |
| \`get_trend_detail\` | Yes | Get full details for a trend by ID |
| \`get_daily_digest\` | No | Persistent and cross-platform topic digest |

## Authentication

Set the \`X-API-Key\` header for authenticated access. Without a key, anonymous tier allows 10 requests/hour.

## Version

$VERSION
EOMD

# ── ClawHub Plugin ──────────────────────────────────────
CH_DIR="$ROOT/dist/clawhub-plugin"
rm -rf "$CH_DIR"
mkdir -p "$CH_DIR/skill"

sed "s/^version: .*/version: $VERSION/" "$ROOT/skill/SKILL.md" > "$CH_DIR/skill/SKILL.md"

node -e "
const m = JSON.parse(require('fs').readFileSync('$ROOT/skill/manifest.json','utf8'));
m.version = '$VERSION';
console.log(JSON.stringify(m, null, 2));
" > "$CH_DIR/skill/manifest.json"

cat > "$CH_DIR/README.md" <<EOMD
# $PACKAGE_NAME — ClawHub Plugin

$DESCRIPTION

## Contents

- \`skill/SKILL.md\` — Skill definition with metadata frontmatter
- \`skill/manifest.json\` — Commands, integration config, pricing tiers

## MCP Server

URL: \`$MCP_URL\`

6 tools: list_platforms, trending_now, search_trends, query_trends, get_trend_detail, get_daily_digest

Authentication: \`X-API-Key\` header (optional — anonymous tier allows 10 requests/hour).

## Version

$VERSION
EOMD

echo ""
echo "Done! Generated:"
echo "  $CC_DIR/"
echo "  $CH_DIR/"
