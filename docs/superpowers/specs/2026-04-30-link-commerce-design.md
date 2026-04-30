# link-commerce Module Design

## Context

UniSCRM is a monorepo with modules deployed as independent Cloudflare Workers on subdomains. The existing `link-content` module handles content aggregation from channels (Notion, Local) with a plugin pattern. We need a new `link-commerce` module on the `/commerce` subdomain to manage product connections from multiple commerce channels (Link URLs, Shopify).

All channels use a unified data structure with `CHANNEL_TYPE` discriminator, following the same pattern as `link-content`.

## Decisions

- **Independent module** — separate Cloudflare Worker, own frontend SPA, own D1 migration for `products` table
- **Shared auth via KV** — no auth code duplication; sub-modules read session from shared KV namespace. Refactor `link-content` to remove its local `auth/session.ts` (replace with inline KV read in middleware)
- **Shared `oauth_tokens` table** — reuse existing table with `provider='shopify'`, store shop domain in `channel_name` field (rename `workspace_name` → `channel_name` across codebase)
- **Vectorize integration** — product title + description embedded for cross-module recommendations in web
- **Shopify OAuth App** — standard third-party app flow via Admin API
- **Link parsing** — fetch URL, extract `<title>` + `<meta name="description">` as product description
- **Product selection UI** — checkbox list with "Select All" for Shopify products, like Notion folder selection

## Data Model

### `products` table (new, link-commerce migrations)

```sql
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,        -- "LINK" or "SHOPIFY"
  channel_source_id TEXT,            -- Shopify product ID or URL hash
  title TEXT NOT NULL,
  description TEXT,
  source_url TEXT,
  source_modified_at TEXT,           -- for delta sync
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_products_user ON products(user_id);
CREATE INDEX idx_products_channel_type ON products(user_id, channel_type);
CREATE UNIQUE INDEX idx_products_user_channel_source ON products(user_id, channel_type, channel_source_id);
```

### `oauth_tokens` table (existing, shared D1)

Reuse with `provider = 'shopify'`. Rename `workspace_name` column to `channel_name` via new migration in link-content. Stores the Shopify shop domain (e.g., `my-store.myshopify.com`) or Notion workspace name. Schema supports this via the `(user_id, provider)` unique constraint with ON CONFLICT upsert.

```sql
-- link-content/migrations/0004_rename_workspace_name.sql
ALTER TABLE oauth_tokens RENAME COLUMN workspace_name TO channel_name;
```

Update all references in link-content code:
- `src/types.ts`: `OAuthTokenRow.workspace_name` → `channel_name`
- `src/api/channels.ts`: response field + Notion callback data
- `src/services/oauth.ts`: INSERT/UPDATE SQL + parameter
- `frontend/hooks/useNotion.ts`: `workspace_name` → `channel_name`
- `frontend/lib/api.ts`: response type
- `frontend/components/NotionConnect.tsx`: `workspaceName` prop (can keep camelCase internally)

## Backend Architecture

### Directory Structure

```
link-commerce/
├── src/
│   ├── index.ts              # Hono app + routes + auth middleware
│   ├── types.ts              # Env, ProductRow, CommerceChannelType
│   ├── api/
│   │   ├── channels.ts       # Shopify OAuth + Link add
│   │   └── products.ts       # Product list + delete
│   ├── channels/
│   │   ├── interface.ts      # CommerceChannel interface
│   │   ├── shopify.ts        # Shopify Admin API (fetch products)
│   │   └── link.ts           # URL fetch + parse title/meta
│   └── services/
│       ├── product.ts        # Sync logic + Vectorize embedding
│       └── oauth.ts          # OAuth token CRUD (reads/writes oauth_tokens table)
├── frontend/                 # React SPA
├── migrations/
│   └── 0001_create_products.sql
├── wrangler.toml
├── package.json
├── tsconfig.json
├── vite.config.ts
└── vitest.config.ts
```

### Auth Middleware (shared KV, no session.ts)

```typescript
// Inline KV session read — no SessionService class needed
export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const sessionId = getCookie(c, "session");
  if (!sessionId) return c.json({ error: "Unauthorized" }, 401);

  const data = await c.env.KV.get(`session:${sessionId}`);
  if (!data) return c.json({ error: "Unauthorized" }, 401);

  const session = JSON.parse(data) as Session;
  c.set("userId", session.user_id);
  c.set("email", session.email);
  await next();
}
```

Also refactor `link-content/src/auth/` to use this same inline pattern (delete `session.ts`).

### API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/channels/shopify/auth` | Yes | Generate Shopify OAuth URL, redirect |
| GET | `/api/channels/shopify/callback` | No | OAuth callback, store token |
| GET | `/api/channels/shopify/status` | Yes | Check if Shopify is connected |
| GET | `/api/channels/shopify/products` | Yes | Fetch product list from Shopify (for selection) |
| POST | `/api/channels/shopify/sync` | Yes | Sync selected products to D1 + Vectorize |
| POST | `/api/channels/link/add` | Yes | Add product by URL (parse title + meta) |
| GET | `/api/products` | Yes | List user's products (all channels) |
| DELETE | `/api/products/:id` | Yes | Delete a product |

### Channel Interface

```typescript
export interface CommerceChannelItem {
  channel_source_id: string;
  title: string;
  description: string | null;
  source_url: string | null;
  source_modified_at: string | null;
}

export interface CommerceChannel {
  type: CommerceChannelType;
  fetchProducts(config: Record<string, unknown>): Promise<CommerceChannelItem[]>;
  requiresAuth(): boolean;
}
```

### Shopify Channel

- OAuth flow: standard Shopify App OAuth (authorize → callback → access_token)
- Fetch products via Shopify Admin REST API (`GET /admin/api/2024-01/products.json`)
- Map to `CommerceChannelItem`: id → channel_source_id, title → title, body_html → description (strip HTML), handle URL → source_url, updated_at → source_modified_at

### Link Channel

- `POST /api/channels/link/add` receives `{ title, url }`
- Backend fetches URL, parses `<title>` and `<meta name="description" content="...">` from HTML
- Stores: user-provided title as `title`, parsed title + meta description as `description`, URL as both `source_url` and `channel_source_id`

### Sync Logic (ProductService)

1. Receive selected Shopify product IDs from frontend
2. Fetch full product data from Shopify API for those IDs
3. For each product: compare `source_modified_at` with stored value, skip if unchanged
4. Upsert to `products` table (ON CONFLICT update)
5. Generate embeddings for new/updated products using `@cf/baai/bge-base-en-v1.5`
6. Store vectors in Vectorize with metadata: `{ type: "product", user_id, product_id, title }`
7. Return `{ added, updated, skipped }`

## Frontend Architecture

### Tech Stack
- React 19, React Router DOM 7, Tailwind CSS 4, Vite
- Same patterns as `link-content/frontend/`

### Page Structure (`frontend/pages/Commerce.tsx`)

Top: channel cards in 2-column grid
Bottom: unified product table

### Components

1. **`LinkAdd`** — card with "+ Add Link" button
   - Click → inline form expands (state-driven, like NotionConnect folder expansion)
   - Fields: product name (required), URL (required)
   - Submit → POST `/api/channels/link/add` → refresh product list
   - Loading state during URL parsing

2. **`ShopifyConnect`** — mirrors NotionConnect exactly
   - Unauthorized: "Connect Shopify" button → OAuth redirect
   - Authorized: shop name display + "Select" / "Sync" buttons
   - "Select" → expand product checkbox list (fetched from Shopify API), "Select All" toggle + "Confirm" / "Cancel"
   - "Sync" → sync selected products, show `{ added, updated, skipped }` result
   - Loading/syncing states

3. **`ProductTable`** — mirrors ContentTable
   - Columns: name, channel badge (LINK/SHOPIFY with colored badges), description (truncated), updated time (relative)
   - Actions: delete button

### Hooks

- `useProducts()` — fetch product list, delete product, refresh
- `useShopify()` — OAuth status, fetch Shopify products, save selection, trigger sync

### API Client (`frontend/lib/api.ts`)

```typescript
const BASE = "/api";

export const api = {
  products: { list, delete },
  shopify: { getAuthUrl, getStatus, getProducts, sync },
  link: { add },
};
```

## Wrangler Configuration

```toml
name = "link-commerce"
main = "src/index.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]
assets = { directory = "./dist" }

[observability]
enabled = true

[env.dev]
name = "link-commerce-dev"

[[env.dev.kv_namespaces]]
binding = "KV"
id = "<same KV as web and link-content>"

[[env.dev.d1_databases]]
binding = "DB"
database_name = "trend-skill-db-dev"
database_id = "<same D1 as other modules>"
migrations_dir = "migrations"

[[env.dev.vectorize]]
binding = "VECTORIZE"
index_name = "trend-embeddings-dev"

[env.dev.ai]
binding = "AI"

[env.dev.vars]
SHOPIFY_CLIENT_ID = ""
SHOPIFY_CLIENT_SECRET = ""
SHOPIFY_REDIRECT_URI = ""
```

## Refactoring: link-content

### Auth simplification
Remove `link-content/src/auth/session.ts`. Simplify `link-content/src/auth/middleware.ts` to inline KV read (same as link-commerce pattern above). Remove `SessionService` import and class.

### Rename `workspace_name` → `channel_name`
New migration `0004_rename_workspace_name.sql`. Update all backend references in types, API handlers, OAuth service. Update frontend hooks and API client response types.

## Verification

1. **Auth flow**: Login via web module → navigate to /commerce → verify session cookie works (products API returns 200, not 401)
2. **Link channel**: Add a product URL → verify title + meta description parsed correctly → product appears in table
3. **Shopify OAuth**: Click Connect → complete OAuth → verify token stored in oauth_tokens with provider='shopify'
4. **Shopify product selection**: Click Select → verify product list loads from Shopify → select some → Confirm
5. **Shopify sync**: Click Sync → verify products upserted to D1, vectors stored in Vectorize, unchanged products skipped
6. **Vectorize**: Verify product embeddings are queryable from web module's recommendation system
7. **link-content regression**: After auth refactor, verify link-content still works (Notion connect, content sync)
