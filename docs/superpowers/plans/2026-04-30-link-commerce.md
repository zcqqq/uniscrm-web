# link-commerce Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `link-commerce` module — an independent Cloudflare Worker on the `/commerce` subdomain that lets users connect commerce channels (manual links, Shopify) and sync product data into a unified table with Vectorize embeddings.

**Architecture:** Independent Worker mirroring `link-content` patterns. Shared KV for session auth (no local SessionService), shared D1 database (new `products` table, reuse existing `oauth_tokens` table). React 19 + Tailwind 4 frontend SPA with channel card grid + product table.

**Tech Stack:** Hono 4.7, React 19, Tailwind CSS 4, Vite, Cloudflare Workers (D1, KV, Vectorize, AI), Shopify Admin REST API, Vitest

**Spec:** `docs/superpowers/specs/2026-04-30-link-commerce-design.md`

---

### Task 1: Refactor link-content — rename `workspace_name` → `channel_name` and simplify auth

**Files:**
- Create: `link-content/migrations/0005_rename_workspace_name.sql`
- Modify: `link-content/src/types.ts:45`
- Modify: `link-content/src/services/oauth.ts:20-44`
- Modify: `link-content/src/api/channels.ts:32,161,167`
- Modify: `link-content/src/auth/middleware.ts` (full rewrite)
- Delete: `link-content/src/auth/session.ts`
- Modify: `link-content/src/api/channels.ts:7,134` (remove SessionService import/usage)
- Modify: `link-content/frontend/lib/api.ts:67`
- Modify: `link-content/frontend/hooks/useNotion.ts:17`

- [ ] **Step 1: Create migration to rename column**

Create `link-content/migrations/0005_rename_workspace_name.sql`:

```sql
ALTER TABLE oauth_tokens RENAME COLUMN workspace_name TO channel_name;
```

- [ ] **Step 2: Update `OAuthTokenRow` type**

In `link-content/src/types.ts`, change line 45:

```typescript
// Before:
  workspace_name: string | null;
// After:
  channel_name: string | null;
```

- [ ] **Step 3: Update `OAuthService.saveToken`**

In `link-content/src/services/oauth.ts`, replace all `workspace_name` with `channel_name`:

```typescript
import type { OAuthTokenRow } from "../types";

export class OAuthService {
  constructor(private db: D1Database) {}

  async getToken(userId: string, provider: string): Promise<OAuthTokenRow | null> {
    return this.db
      .prepare("SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?")
      .bind(userId, provider)
      .first<OAuthTokenRow>();
  }

  async saveToken(
    userId: string,
    provider: string,
    token: {
      access_token: string;
      refresh_token?: string | null;
      expires_at?: string | null;
      channel_name?: string | null;
    }
  ): Promise<void> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await this.db
      .prepare(
        `INSERT INTO oauth_tokens (id, user_id, provider, access_token, refresh_token, expires_at, channel_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           channel_name = excluded.channel_name,
           updated_at = excluded.updated_at`
      )
      .bind(
        id,
        userId,
        provider,
        token.access_token,
        token.refresh_token ?? null,
        token.expires_at ?? null,
        token.channel_name ?? null,
        now,
        now
      )
      .run();
  }

  async deleteToken(userId: string, provider: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM oauth_tokens WHERE user_id = ? AND provider = ?")
      .bind(userId, provider)
      .run();
  }
}
```

- [ ] **Step 4: Update channels API — status response and callback**

In `link-content/src/api/channels.ts`:

1. Line 32: change `workspace_name: token.workspace_name` → `channel_name: token.channel_name`
2. Lines 159-167: change Notion callback tokenData type and saveToken call:

```typescript
    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      workspace_name?: string; // Notion API still returns workspace_name
    };

    const oauth = new OAuthService(c.env.DB);
    await oauth.saveToken(session.user_id, "notion", {
      access_token: tokenData.access_token,
      channel_name: tokenData.workspace_name ?? null, // map Notion's field to our field
    });
```

- [ ] **Step 5: Simplify auth middleware — remove SessionService**

Replace `link-content/src/auth/middleware.ts` entirely:

```typescript
import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import type { Env, Session } from "../types";

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const sessionId = getCookie(c, "session");
  if (!sessionId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const data = await c.env.KV.get(`session:${sessionId}`);
  if (!data) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const session = JSON.parse(data) as Session;
  c.set("userId" as never, session.user_id);
  c.set("email" as never, session.email);
  await next();
}
```

- [ ] **Step 6: Delete `session.ts` and update Notion callback to inline KV read**

Delete `link-content/src/auth/session.ts`.

In `link-content/src/api/channels.ts`, the `createNotionCallbackRouter` function uses `SessionService` to validate the OAuth state. Replace it with inline KV read:

```typescript
// Remove this import:
// import { SessionService } from "../auth/session";

// In createNotionCallbackRouter, replace:
//   const sessions = new SessionService(c.env.KV);
//   const session = await sessions.get(state);
// With:
    const data = await c.env.KV.get(`session:${state}`);
    const session = data ? (JSON.parse(data) as { user_id: string; email: string }) : null;
```

- [ ] **Step 7: Update frontend API type**

In `link-content/frontend/lib/api.ts`, line 67:

```typescript
// Before:
    getStatus: () =>
      request<{ connected: boolean; workspace_name?: string }>("/channels/notion/status"),
// After:
    getStatus: () =>
      request<{ connected: boolean; channel_name?: string }>("/channels/notion/status"),
```

- [ ] **Step 8: Update `useNotion` hook**

In `link-content/frontend/hooks/useNotion.ts`, line 17:

```typescript
// Before:
      setWorkspaceName(res.workspace_name ?? null);
// After:
      setWorkspaceName(res.channel_name ?? null);
```

(The internal state variable name `workspaceName` and the component prop can stay as-is since they're just camelCase React conventions.)

- [ ] **Step 9: Run migration and verify**

```bash
cd link-content
npx wrangler d1 migrations apply trend-skill-db-dev --env dev --local
```

- [ ] **Step 10: Start link-content dev server and verify Notion still works**

```bash
cd link-content
npm run dev:worker &
npm run dev
```

Open the content page, verify Notion connection status shows correctly, folder selection works, sync works. The workspace name should still display next to "Notion".

- [ ] **Step 11: Commit**

```bash
git add link-content/migrations/0005_rename_workspace_name.sql link-content/src/types.ts link-content/src/services/oauth.ts link-content/src/api/channels.ts link-content/src/auth/middleware.ts link-content/frontend/lib/api.ts link-content/frontend/hooks/useNotion.ts
git rm link-content/src/auth/session.ts
git commit -m "refactor(link-content): rename workspace_name to channel_name, simplify auth middleware"
```

---

### Task 2: Scaffold link-commerce module — project files, wrangler config, migration

**Files:**
- Create: `link-commerce/package.json`
- Create: `link-commerce/tsconfig.json`
- Create: `link-commerce/wrangler.toml`
- Create: `link-commerce/vite.config.ts`
- Create: `link-commerce/migrations/0001_create_products.sql`
- Create: `link-commerce/src/types.ts`

- [ ] **Step 1: Create `link-commerce/package.json`**

```json
{
  "name": "link-commerce",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "dev:worker": "wrangler dev --env dev --port 8790",
    "build": "vite build",
    "deploy:dev": "wrangler deploy --env dev",
    "deploy:prod": "wrangler deploy --env production",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "hono": "^4.7.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "@cloudflare/workers-types": "^4.20250410.0",
    "@tailwindcss/vite": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.8.0",
    "vitest": "^3.1.0",
    "wrangler": "^4.10.0"
  }
}
```

- [ ] **Step 2: Create `link-commerce/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["@cloudflare/workers-types/2023-07-01", "vite/client", "@cloudflare/vitest-pool-workers"],
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "frontend/**/*.tsx", "frontend/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `link-commerce/wrangler.toml`**

Use the same KV ID and D1 database ID as link-content. Port 8790 to avoid conflict with web (8788) and link-content (8789).

```toml
name = "link-commerce"
main = "src/index.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "single-page-application"

[observability]
enabled = true
head_sampling_rate = 1

[env.dev]
name = "link-commerce-dev"

[[env.dev.kv_namespaces]]
binding = "KV"
id = "ac8b64b59ac540e0ab482f25bb78d41e"

[[env.dev.d1_databases]]
binding = "DB"
database_name = "trend-skill-db-dev"
database_id = "b322777d-6617-4dbf-a4d2-f734166b7737"
migrations_dir = "migrations"

[[env.dev.vectorize]]
binding = "VECTORIZE"
index_name = "trend-embeddings-dev"

[env.dev.ai]
binding = "AI"

[env.production]
name = "link-commerce"

[[env.production.kv_namespaces]]
binding = "KV"
id = "<prod-kv-id>"

[[env.production.d1_databases]]
binding = "DB"
database_name = "trend-skill-db"
database_id = "<prod-d1-id>"
migrations_dir = "migrations"

[[env.production.vectorize]]
binding = "VECTORIZE"
index_name = "trend-embeddings"

[env.production.ai]
binding = "AI"
```

- [ ] **Step 4: Create `link-commerce/vite.config.ts`**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  root: "./frontend",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:8790",
    },
  },
});
```

- [ ] **Step 5: Create `link-commerce/migrations/0001_create_products.sql`**

```sql
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  channel_source_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  source_url TEXT,
  source_modified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_products_user ON products(user_id);
CREATE INDEX idx_products_channel_type ON products(user_id, channel_type);
CREATE UNIQUE INDEX idx_products_user_channel_source ON products(user_id, channel_type, channel_source_id);
```

- [ ] **Step 6: Create `link-commerce/src/types.ts`**

```typescript
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  ASSETS: Fetcher;
  SHOPIFY_CLIENT_ID: string;
  SHOPIFY_CLIENT_SECRET: string;
  SHOPIFY_REDIRECT_URI: string;
}

export type CommerceChannelType = "LINK" | "SHOPIFY";

export interface ProductRow {
  id: string;
  user_id: string;
  channel_type: CommerceChannelType;
  channel_source_id: string;
  title: string;
  description: string | null;
  source_url: string | null;
  source_modified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OAuthTokenRow {
  id: string;
  user_id: string;
  provider: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null;
  channel_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  user_id: string;
  email: string;
  expires_at: string;
}
```

- [ ] **Step 7: Install dependencies and run migration**

```bash
cd link-commerce
npm install
npx wrangler d1 migrations apply trend-skill-db-dev --env dev --local
```

- [ ] **Step 8: Commit**

```bash
git add link-commerce/package.json link-commerce/tsconfig.json link-commerce/wrangler.toml link-commerce/vite.config.ts link-commerce/migrations/0001_create_products.sql link-commerce/src/types.ts
git commit -m "feat(link-commerce): scaffold module with project config and products migration"
```

---

### Task 3: Backend — auth middleware, OAuth service, channel interfaces

**Files:**
- Create: `link-commerce/src/auth/middleware.ts`
- Create: `link-commerce/src/services/oauth.ts`
- Create: `link-commerce/src/channels/interface.ts`

- [ ] **Step 1: Create auth middleware**

Create `link-commerce/src/auth/middleware.ts`:

```typescript
import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import type { Env, Session } from "../types";

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const sessionId = getCookie(c, "session");
  if (!sessionId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const data = await c.env.KV.get(`session:${sessionId}`);
  if (!data) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const session = JSON.parse(data) as Session;
  c.set("userId" as never, session.user_id);
  c.set("email" as never, session.email);
  await next();
}
```

- [ ] **Step 2: Create OAuth service**

Create `link-commerce/src/services/oauth.ts`:

```typescript
import type { OAuthTokenRow } from "../types";

export class OAuthService {
  constructor(private db: D1Database) {}

  async getToken(userId: string, provider: string): Promise<OAuthTokenRow | null> {
    return this.db
      .prepare("SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = ?")
      .bind(userId, provider)
      .first<OAuthTokenRow>();
  }

  async saveToken(
    userId: string,
    provider: string,
    token: {
      access_token: string;
      refresh_token?: string | null;
      expires_at?: string | null;
      channel_name?: string | null;
    }
  ): Promise<void> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await this.db
      .prepare(
        `INSERT INTO oauth_tokens (id, user_id, provider, access_token, refresh_token, expires_at, channel_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           expires_at = excluded.expires_at,
           channel_name = excluded.channel_name,
           updated_at = excluded.updated_at`
      )
      .bind(
        id,
        userId,
        provider,
        token.access_token,
        token.refresh_token ?? null,
        token.expires_at ?? null,
        token.channel_name ?? null,
        now,
        now
      )
      .run();
  }
}
```

- [ ] **Step 3: Create channel interface**

Create `link-commerce/src/channels/interface.ts`:

```typescript
import type { CommerceChannelType } from "../types";

export interface CommerceChannelItem {
  channel_source_id: string;
  title: string;
  description: string | null;
  source_url: string | null;
  source_modified_at: string | null;
}
```

- [ ] **Step 4: Commit**

```bash
git add link-commerce/src/auth/middleware.ts link-commerce/src/services/oauth.ts link-commerce/src/channels/interface.ts
git commit -m "feat(link-commerce): add auth middleware, OAuth service, channel interface"
```

---

### Task 4: Backend — Link channel (URL parsing)

**Files:**
- Create: `link-commerce/src/channels/link.ts`

- [ ] **Step 1: Create Link channel**

Create `link-commerce/src/channels/link.ts`:

```typescript
import type { CommerceChannelItem } from "./interface";

export async function parseProductUrl(url: string): Promise<{ title: string; description: string | null }> {
  const res = await fetch(url, {
    headers: { "User-Agent": "UniSCRM-Bot/1.0" },
    redirect: "follow",
  });

  if (!res.ok) {
    return { title: url, description: null };
  }

  const html = await res.text();

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : url;

  const metaMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i)
    || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
  const description = metaMatch ? metaMatch[1].trim() : null;

  const parts = [title];
  if (description) parts.push(description);

  return { title, description: parts.join(" — ") };
}

export function buildLinkItem(
  userTitle: string,
  url: string,
  parsed: { title: string; description: string | null }
): CommerceChannelItem {
  return {
    channel_source_id: url,
    title: userTitle,
    description: parsed.description,
    source_url: url,
    source_modified_at: new Date().toISOString(),
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add link-commerce/src/channels/link.ts
git commit -m "feat(link-commerce): add Link channel URL parser"
```

---

### Task 5: Backend — Shopify channel (OAuth + product fetch)

**Files:**
- Create: `link-commerce/src/channels/shopify.ts`

- [ ] **Step 1: Create Shopify channel**

Create `link-commerce/src/channels/shopify.ts`:

```typescript
import type { CommerceChannelItem } from "./interface";

interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string | null;
  handle: string;
  updated_at: string;
}

interface ShopifyProductsResponse {
  products: ShopifyProduct[];
}

export function buildShopifyAuthUrl(
  shopDomain: string,
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const scopes = "read_products";
  return `https://${shopDomain}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
}

export async function exchangeShopifyCode(
  shopDomain: string,
  clientId: string,
  clientSecret: string,
  code: string
): Promise<{ access_token: string }> {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Shopify token exchange failed: ${err}`);
  }

  return res.json() as Promise<{ access_token: string }>;
}

export async function fetchShopifyProducts(
  shopDomain: string,
  accessToken: string
): Promise<CommerceChannelItem[]> {
  const res = await fetch(
    `https://${shopDomain}/admin/api/2024-01/products.json?fields=id,title,body_html,handle,updated_at&limit=250`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Shopify API error: ${res.status}`);
  }

  const data = (await res.json()) as ShopifyProductsResponse;

  return data.products.map((p) => ({
    channel_source_id: String(p.id),
    title: p.title,
    description: p.body_html ? stripHtml(p.body_html) : null,
    source_url: `https://${shopDomain}/products/${p.handle}`,
    source_modified_at: p.updated_at,
  }));
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
```

- [ ] **Step 2: Commit**

```bash
git add link-commerce/src/channels/shopify.ts
git commit -m "feat(link-commerce): add Shopify channel (OAuth + product fetch)"
```

---

### Task 6: Backend — ProductService (sync + Vectorize embedding)

**Files:**
- Create: `link-commerce/src/services/product.ts`

- [ ] **Step 1: Create ProductService**

Create `link-commerce/src/services/product.ts`:

```typescript
import type { ProductRow, CommerceChannelType } from "../types";
import type { CommerceChannelItem } from "../channels/interface";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

export interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
}

export class ProductService {
  constructor(
    private db: D1Database,
    private vectorize: VectorizeIndex,
    private ai: Ai
  ) {}

  async syncBatch(
    userId: string,
    channelType: CommerceChannelType,
    items: CommerceChannelItem[]
  ): Promise<SyncResult> {
    const now = new Date().toISOString();

    const { results: existing } = await this.db
      .prepare(
        "SELECT id, channel_source_id, source_modified_at FROM products WHERE user_id = ? AND channel_type = ?"
      )
      .bind(userId, channelType)
      .all<{ id: string; channel_source_id: string; source_modified_at: string | null }>();

    const existingMap = new Map(existing.map((e) => [e.channel_source_id, e]));

    let added = 0;
    let updated = 0;
    let skipped = 0;
    const needsEmbedding: ProductRow[] = [];

    for (const item of items) {
      const ex = existingMap.get(item.channel_source_id);

      if (ex && ex.source_modified_at === item.source_modified_at) {
        skipped++;
        continue;
      }

      const row: ProductRow = {
        id: ex?.id ?? crypto.randomUUID(),
        user_id: userId,
        channel_type: channelType,
        channel_source_id: item.channel_source_id,
        title: item.title,
        description: item.description,
        source_url: item.source_url,
        source_modified_at: item.source_modified_at,
        created_at: ex ? now : now,
        updated_at: now,
      };

      if (ex) {
        await this.db
          .prepare(
            "UPDATE products SET title = ?, description = ?, source_url = ?, source_modified_at = ?, updated_at = ? WHERE id = ?"
          )
          .bind(item.title, item.description, item.source_url, item.source_modified_at, now, ex.id)
          .run();
        updated++;
      } else {
        await this.db
          .prepare(
            "INSERT INTO products (id, user_id, channel_type, channel_source_id, title, description, source_url, source_modified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(row.id, userId, channelType, item.channel_source_id, item.title, item.description, item.source_url, item.source_modified_at, now, now)
          .run();
        added++;
      }

      needsEmbedding.push(row);
    }

    await this.embedProducts(userId, needsEmbedding);
    return { added, updated, skipped };
  }

  async addSingle(
    userId: string,
    channelType: CommerceChannelType,
    item: CommerceChannelItem
  ): Promise<ProductRow> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();

    await this.db
      .prepare(
        "INSERT INTO products (id, user_id, channel_type, channel_source_id, title, description, source_url, source_modified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(id, userId, channelType, item.channel_source_id, item.title, item.description, item.source_url, item.source_modified_at, now, now)
      .run();

    const row: ProductRow = {
      id,
      user_id: userId,
      channel_type: channelType,
      channel_source_id: item.channel_source_id,
      title: item.title,
      description: item.description,
      source_url: item.source_url,
      source_modified_at: item.source_modified_at,
      created_at: now,
      updated_at: now,
    };

    await this.embedProducts(userId, [row]);
    return row;
  }

  async listByUser(userId: string): Promise<ProductRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM products WHERE user_id = ? ORDER BY updated_at DESC")
      .bind(userId)
      .all<ProductRow>();
    return results;
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM products WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .run();
    await this.vectorize.deleteByIds([id]);
  }

  private async embedProducts(userId: string, items: ProductRow[]): Promise<void> {
    if (items.length === 0) return;

    const texts = items.map((item) => {
      const parts = [item.title];
      if (item.description) parts.push(item.description);
      return parts.join(" | ");
    });

    const embedResult = (await this.ai.run(EMBEDDING_MODEL, { text: texts })) as {
      data: number[][];
    };

    const records = items.map((item, i) => ({
      id: item.id,
      values: embedResult.data[i],
      metadata: {
        type: "product",
        user_id: userId,
        product_id: item.id,
        title: item.title,
        timestamp_ms: Date.now(),
      },
    }));

    await this.vectorize.upsert(records);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add link-commerce/src/services/product.ts
git commit -m "feat(link-commerce): add ProductService with sync and Vectorize embedding"
```

---

### Task 7: Backend — API routes and main entry point

**Files:**
- Create: `link-commerce/src/api/channels.ts`
- Create: `link-commerce/src/api/products.ts`
- Create: `link-commerce/src/index.ts`

- [ ] **Step 1: Create channels API router**

Create `link-commerce/src/api/channels.ts`:

```typescript
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { Env, Session } from "../types";
import { OAuthService } from "../services/oauth";
import { ProductService } from "../services/product";
import {
  buildShopifyAuthUrl,
  exchangeShopifyCode,
  fetchShopifyProducts,
} from "../channels/shopify";
import { parseProductUrl, buildLinkItem } from "../channels/link";

export function createChannelsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/shopify/auth", async (c) => {
    const { shop } = c.req.query();
    if (!shop) {
      return c.json({ error: "Missing shop parameter" }, 400);
    }
    const sessionId = getCookie(c, "session") ?? "";
    const url = buildShopifyAuthUrl(
      shop,
      c.env.SHOPIFY_CLIENT_ID,
      c.env.SHOPIFY_REDIRECT_URI,
      sessionId
    );
    return c.json({ url });
  });

  router.get("/shopify/status", async (c) => {
    const userId = c.get("userId" as never) as string;
    const oauth = new OAuthService(c.env.DB);
    const token = await oauth.getToken(userId, "shopify");
    if (!token) {
      return c.json({ connected: false });
    }
    return c.json({ connected: true, channel_name: token.channel_name });
  });

  router.get("/shopify/products", async (c) => {
    const userId = c.get("userId" as never) as string;
    const oauth = new OAuthService(c.env.DB);
    const token = await oauth.getToken(userId, "shopify");
    if (!token || !token.channel_name) {
      return c.json({ error: "Shopify not connected" }, 401);
    }
    const products = await fetchShopifyProducts(token.channel_name, token.access_token);
    return c.json({ products });
  });

  router.post("/shopify/sync", async (c) => {
    const userId = c.get("userId" as never) as string;
    const { product_ids } = await c.req.json<{ product_ids: string[] }>();

    const oauth = new OAuthService(c.env.DB);
    const token = await oauth.getToken(userId, "shopify");
    if (!token || !token.channel_name) {
      return c.json({ error: "Shopify not connected" }, 401);
    }

    const allProducts = await fetchShopifyProducts(token.channel_name, token.access_token);
    const selectedIds = new Set(product_ids);
    const selected = allProducts.filter((p) => selectedIds.has(p.channel_source_id));

    const service = new ProductService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    const result = await service.syncBatch(userId, "SHOPIFY", selected);
    return c.json(result);
  });

  router.post("/link/add", async (c) => {
    const userId = c.get("userId" as never) as string;
    const { title, url } = await c.req.json<{ title: string; url: string }>();

    if (!title || !url) {
      return c.json({ error: "title and url are required" }, 400);
    }

    const parsed = await parseProductUrl(url);
    const item = buildLinkItem(title, url, parsed);

    const service = new ProductService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    const product = await service.addSingle(userId, "LINK", item);
    return c.json({ product });
  });

  return router;
}

export function createShopifyCallbackRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/shopify/callback", async (c) => {
    const code = c.req.query("code");
    const shop = c.req.query("shop");
    const state = c.req.query("state");

    if (!code || !shop || !state) {
      return c.json({ error: "Missing code, shop, or state" }, 400);
    }

    const data = await c.env.KV.get(`session:${state}`);
    if (!data) {
      return c.json({ error: "Invalid session" }, 401);
    }
    const session = JSON.parse(data) as Session;

    const tokenData = await exchangeShopifyCode(
      shop,
      c.env.SHOPIFY_CLIENT_ID,
      c.env.SHOPIFY_CLIENT_SECRET,
      code
    );

    const oauth = new OAuthService(c.env.DB);
    await oauth.saveToken(session.user_id, "shopify", {
      access_token: tokenData.access_token,
      channel_name: shop,
    });

    return c.redirect("/?shopify=connected");
  });

  return router;
}
```

- [ ] **Step 2: Create products API router**

Create `link-commerce/src/api/products.ts`:

```typescript
import { Hono } from "hono";
import type { Env } from "../types";
import { ProductService } from "../services/product";

export function createProductsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const userId = c.get("userId" as never) as string;
    const service = new ProductService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    const items = await service.listByUser(userId);
    return c.json({ items });
  });

  router.delete("/:id", async (c) => {
    const userId = c.get("userId" as never) as string;
    const id = c.req.param("id");
    const service = new ProductService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    await service.delete(id, userId);
    return c.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 3: Create main entry point**

Create `link-commerce/src/index.ts`:

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { authMiddleware } from "./auth/middleware";
import { createChannelsRouter, createShopifyCallbackRouter } from "./api/channels";
import { createProductsRouter } from "./api/products";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*", credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/channels", createShopifyCallbackRouter());

app.use("/api/*", authMiddleware);
app.route("/api/channels", createChannelsRouter());
app.route("/api/products", createProductsRouter());

app.all("/*", async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
};
```

- [ ] **Step 4: Verify backend compiles**

```bash
cd link-commerce
npx tsc --noEmit
```

Expected: no errors (some may come from missing frontend files — that's OK, we'll add them next).

- [ ] **Step 5: Commit**

```bash
git add link-commerce/src/index.ts link-commerce/src/api/channels.ts link-commerce/src/api/products.ts
git commit -m "feat(link-commerce): add API routes and main entry point"
```

---

### Task 8: Frontend — scaffold, API client, hooks

**Files:**
- Create: `link-commerce/frontend/index.html`
- Create: `link-commerce/frontend/index.css`
- Create: `link-commerce/frontend/main.tsx`
- Create: `link-commerce/frontend/App.tsx`
- Create: `link-commerce/frontend/lib/api.ts`
- Create: `link-commerce/frontend/hooks/useProducts.ts`
- Create: `link-commerce/frontend/hooks/useShopify.ts`

- [ ] **Step 1: Create `frontend/index.html`**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Product Library</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `frontend/index.css`**

```css
@import "tailwindcss";
```

- [ ] **Step 3: Create `frontend/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 4: Create `frontend/App.tsx`**

```tsx
import { Commerce } from "./pages/Commerce";

export function App() {
  return (
    <div className="min-h-screen bg-gray-50">
      <Commerce />
    </div>
  );
}
```

- [ ] **Step 5: Create `frontend/lib/api.ts`**

```typescript
const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error((err as { error: string }).error);
  }
  return res.json() as Promise<T>;
}

export interface ProductItem {
  id: string;
  user_id: string;
  channel_type: string;
  channel_source_id: string;
  title: string;
  description: string | null;
  source_url: string | null;
  source_modified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncResult {
  added: number;
  updated: number;
  skipped: number;
}

export interface ShopifyProduct {
  channel_source_id: string;
  title: string;
  description: string | null;
  source_url: string | null;
  source_modified_at: string | null;
}

export const api = {
  products: {
    list: () => request<{ items: ProductItem[] }>("/products"),
    delete: (id: string) => request(`/products/${id}`, { method: "DELETE" }),
  },
  shopify: {
    getAuthUrl: (shop: string) =>
      request<{ url: string }>(`/channels/shopify/auth?shop=${encodeURIComponent(shop)}`),
    getStatus: () =>
      request<{ connected: boolean; channel_name?: string }>("/channels/shopify/status"),
    getProducts: () =>
      request<{ products: ShopifyProduct[] }>("/channels/shopify/products"),
    sync: (productIds: string[]) =>
      request<SyncResult>("/channels/shopify/sync", {
        method: "POST",
        body: JSON.stringify({ product_ids: productIds }),
      }),
  },
  link: {
    add: (title: string, url: string) =>
      request<{ product: ProductItem }>("/channels/link/add", {
        method: "POST",
        body: JSON.stringify({ title, url }),
      }),
  },
};
```

- [ ] **Step 6: Create `frontend/hooks/useProducts.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { ProductItem } from "../lib/api";

export function useProducts() {
  const [items, setItems] = useState<ProductItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.products.list();
      setItems(res.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const deleteItem = async (id: string) => {
    await api.products.delete(id);
    await refresh();
  };

  return { items, loading, refresh, deleteItem };
}
```

- [ ] **Step 7: Create `frontend/hooks/useShopify.ts`**

```typescript
import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { ShopifyProduct, SyncResult } from "../lib/api";

export function useShopify() {
  const [connected, setConnected] = useState(false);
  const [channelName, setChannelName] = useState<string | null>(null);
  const [products, setProducts] = useState<ShopifyProduct[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const checkStatus = useCallback(async () => {
    try {
      const res = await api.shopify.getStatus();
      setConnected(res.connected);
      setChannelName(res.channel_name ?? null);
    } catch {
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("shopify") === "connected") {
      checkStatus();
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [checkStatus]);

  const startAuth = async (shop: string) => {
    const { url } = await api.shopify.getAuthUrl(shop);
    window.location.href = url;
  };

  const loadProducts = async () => {
    const { products: p } = await api.shopify.getProducts();
    setProducts(p);
  };

  const toggleProduct = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const toggleAll = () => {
    if (selectedIds.length === products.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(products.map((p) => p.channel_source_id));
    }
  };

  const triggerSync = async () => {
    if (selectedIds.length === 0) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await api.shopify.sync(selectedIds);
      setSyncResult(result);
    } finally {
      setSyncing(false);
    }
  };

  return {
    connected,
    channelName,
    products,
    selectedIds,
    syncing,
    syncResult,
    startAuth,
    loadProducts,
    toggleProduct,
    toggleAll,
    triggerSync,
  };
}
```

- [ ] **Step 8: Commit**

```bash
git add link-commerce/frontend/
git commit -m "feat(link-commerce): add frontend scaffold, API client, hooks"
```

---

### Task 9: Frontend — UI components

**Files:**
- Create: `link-commerce/frontend/components/LinkAdd.tsx`
- Create: `link-commerce/frontend/components/ShopifyConnect.tsx`
- Create: `link-commerce/frontend/components/ProductTable.tsx`
- Create: `link-commerce/frontend/pages/Commerce.tsx`

- [ ] **Step 1: Create `LinkAdd` component**

Create `link-commerce/frontend/components/LinkAdd.tsx`:

```tsx
import { useState } from "react";
import { api } from "../lib/api";

interface Props {
  onAdded: () => void;
}

export function LinkAdd({ onAdded }: Props) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || !url.trim()) return;
    setAdding(true);
    try {
      await api.link.add(title.trim(), url.trim());
      setTitle("");
      setUrl("");
      setShowForm(false);
      onAdded();
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="border-2 border-dashed rounded-lg p-6 text-center border-gray-300">
      <div className="text-sm font-medium text-gray-700 mb-2">Link</div>
      <p className="text-gray-500 text-sm mb-3">Add product by URL</p>

      {showForm ? (
        <div className="text-left space-y-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Product name"
            className="w-full px-3 py-1.5 text-sm border rounded-md"
          />
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
            className="w-full px-3 py-1.5 text-sm border rounded-md"
          />
          <div className="flex gap-2">
            <button
              onClick={handleSubmit}
              disabled={adding || !title.trim() || !url.trim()}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {adding ? "Adding..." : "Add"}
            </button>
            <button
              onClick={() => { setShowForm(false); setTitle(""); setUrl(""); }}
              className="px-3 py-1.5 text-sm border rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="px-3 py-1.5 text-sm bg-black text-white rounded-md hover:bg-gray-800"
        >
          + Add Link
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create `ShopifyConnect` component**

Create `link-commerce/frontend/components/ShopifyConnect.tsx`:

```tsx
import { useState, useEffect } from "react";
import { useShopify } from "../hooks/useShopify";

interface Props {
  onSyncComplete: () => void;
}

export function ShopifyConnect({ onSyncComplete }: Props) {
  const {
    connected,
    channelName,
    products,
    selectedIds,
    syncing,
    syncResult,
    startAuth,
    loadProducts,
    toggleProduct,
    toggleAll,
    triggerSync,
  } = useShopify();

  const [shopDomain, setShopDomain] = useState("");
  const [showProducts, setShowProducts] = useState(false);

  useEffect(() => {
    if (syncResult) onSyncComplete();
  }, [syncResult, onSyncComplete]);

  if (!connected) {
    return (
      <div className="border-2 border-dashed rounded-lg p-6 text-center border-gray-300">
        <div className="text-sm font-medium text-gray-700 mb-2">Shopify</div>
        <p className="text-gray-500 text-sm mb-3">Connect your Shopify store</p>
        <div className="space-y-2">
          <input
            value={shopDomain}
            onChange={(e) => setShopDomain(e.target.value)}
            placeholder="my-store.myshopify.com"
            className="w-full px-3 py-1.5 text-sm border rounded-md"
          />
          <button
            onClick={() => shopDomain && startAuth(shopDomain)}
            disabled={!shopDomain}
            className="px-3 py-1.5 text-sm bg-black text-white rounded-md hover:bg-gray-800 disabled:opacity-50"
          >
            Connect Shopify
          </button>
        </div>
      </div>
    );
  }

  const handleOpenProducts = async () => {
    await loadProducts();
    setShowProducts(true);
  };

  const handleSync = async () => {
    await triggerSync();
  };

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <span className="text-sm font-medium text-gray-700">Shopify</span>
          {channelName && (
            <span className="text-xs text-gray-400 ml-2">{channelName}</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleOpenProducts}
            className="px-3 py-1 text-xs border rounded hover:bg-gray-50"
          >
            Select
          </button>
          <button
            onClick={handleSync}
            disabled={syncing || selectedIds.length === 0}
            className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {syncing ? "Syncing..." : "Sync"}
          </button>
        </div>
      </div>

      {syncResult && (
        <div className="text-xs text-gray-500">
          Added: {syncResult.added}, Updated: {syncResult.updated}, Skipped: {syncResult.skipped}
        </div>
      )}

      {showProducts && (
        <div className="mt-3 pt-3 border-t">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium">Select products</h4>
            <label className="flex items-center gap-1 text-xs text-gray-500 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedIds.length === products.length && products.length > 0}
                onChange={toggleAll}
              />
              Select all
            </label>
          </div>
          {products.length === 0 ? (
            <p className="text-sm text-gray-400">No products found</p>
          ) : (
            <div className="max-h-40 overflow-y-auto space-y-1 mb-3">
              {products.map((p) => (
                <label
                  key={p.channel_source_id}
                  className="flex items-center gap-2 text-sm cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(p.channel_source_id)}
                    onChange={() => toggleProduct(p.channel_source_id)}
                  />
                  {p.title}
                </label>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => setShowProducts(false)}
              className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              Confirm
            </button>
            <button
              onClick={() => setShowProducts(false)}
              className="px-3 py-1 text-xs border rounded hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `ProductTable` component**

Create `link-commerce/frontend/components/ProductTable.tsx`:

```tsx
import type { ProductItem } from "../lib/api";

interface Props {
  items: ProductItem[];
  onDelete: (id: string) => Promise<void>;
}

export function ProductTable({ items, onDelete }: Props) {
  if (items.length === 0) {
    return (
      <p className="text-gray-500 text-center py-8">
        No products yet. Add a link or sync from Shopify.
      </p>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left">
          <th className="py-2 font-medium">Name</th>
          <th className="py-2 font-medium w-20">Channel</th>
          <th className="py-2 font-medium">Description</th>
          <th className="py-2 font-medium w-28">Updated</th>
          <th className="py-2 font-medium w-20">Actions</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className="border-b hover:bg-gray-50">
            <td className="py-2">
              {item.source_url ? (
                <a
                  href={item.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium hover:underline text-blue-600"
                >
                  {item.title}
                </a>
              ) : (
                <span className="font-medium">{item.title}</span>
              )}
            </td>
            <td className="py-2">
              <span
                className={`text-xs px-2 py-0.5 rounded-full ${
                  item.channel_type === "LINK"
                    ? "bg-amber-100 text-amber-700"
                    : "bg-blue-100 text-blue-700"
                }`}
              >
                {item.channel_type === "LINK" ? "Link" : "Shopify"}
              </span>
            </td>
            <td className="py-2 text-gray-400 truncate max-w-xs">
              {item.description ?? "—"}
            </td>
            <td className="py-2 text-gray-400">
              {item.source_modified_at
                ? new Date(item.source_modified_at).toLocaleDateString()
                : "—"}
            </td>
            <td className="py-2">
              <button
                onClick={() => onDelete(item.id)}
                className="text-red-500 text-xs hover:underline"
              >
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Create `Commerce` page**

Create `link-commerce/frontend/pages/Commerce.tsx`:

```tsx
import { useCallback } from "react";
import { useProducts } from "../hooks/useProducts";
import { LinkAdd } from "../components/LinkAdd";
import { ShopifyConnect } from "../components/ShopifyConnect";
import { ProductTable } from "../components/ProductTable";

export function Commerce() {
  const { items, loading, refresh, deleteItem } = useProducts();

  const handleChange = useCallback(() => {
    refresh();
  }, [refresh]);

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-6">Product Library</h1>

      <div className="grid grid-cols-2 gap-4 mb-6">
        <LinkAdd onAdded={handleChange} />
        <ShopifyConnect onSyncComplete={handleChange} />
      </div>

      <ProductTable items={items} onDelete={deleteItem} />
    </div>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add link-commerce/frontend/
git commit -m "feat(link-commerce): add frontend UI components and Commerce page"
```

---

### Task 10: End-to-end verification

- [ ] **Step 1: Build and start the full dev environment**

```bash
# Terminal 1: web module (auth provider)
cd web && npm run dev:worker

# Terminal 2: link-commerce backend
cd link-commerce && npm run dev:worker

# Terminal 3: link-commerce frontend
cd link-commerce && npm run dev
```

- [ ] **Step 2: Verify auth flow**

1. Open web module, login via magic link
2. Open link-commerce frontend (Vite dev server port, likely http://localhost:5174)
3. Open browser DevTools → Network tab
4. Verify `GET /api/products` returns 200 (not 401) — proves shared KV session works

- [ ] **Step 3: Verify Link channel**

1. Click "+ Add Link" on the Link card
2. Enter a product name and a URL (e.g., any product page)
3. Click "Add"
4. Verify the product appears in the table with parsed description

- [ ] **Step 4: Verify Shopify OAuth (requires Shopify app credentials)**

If Shopify credentials are configured:
1. Enter shop domain, click "Connect Shopify"
2. Complete OAuth flow
3. Verify redirect back with `?shopify=connected`
4. Verify "Select" button loads products from the store
5. Select some products, click "Confirm", then click "Sync"
6. Verify sync result shows added/updated/skipped counts

- [ ] **Step 5: Verify link-content regression**

```bash
cd link-content && npm run dev:worker &
cd link-content && npm run dev
```

Open the content page, verify Notion connection status still displays, folder selection works, sync works.

- [ ] **Step 6: Commit any fixes and final commit**

```bash
git add -A
git commit -m "feat(link-commerce): complete link-commerce module with Link and Shopify channels"
```
