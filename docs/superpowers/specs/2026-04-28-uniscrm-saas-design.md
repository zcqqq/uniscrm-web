# UniSCRM SaaS Web App Design

## Context

Build a web-based SaaS portal for the existing trend-skill backend. Users log in via email Magic Link, import local `.md` files as their content library, and get recommendations on which content best matches current trends. This is an MVP — content operations are limited to status marking (new / pending / published / ignored).

The trend-skill Worker continues to run independently, fetching and storing trends. The new app shares the same Cloudflare data layer (D1, KV, Vectorize) without runtime coupling.

## Architecture

```
uniscrm/
├── trend-skill/          # Existing, minimal change (add type:"trend" to Vectorize metadata)
│   └── wrangler.toml
└── web/                  # NEW: SaaS app
    ├── src/              # React + Vite SPA (Cloudflare Pages)
    ├── worker/           # Hono Worker backend (Cloudflare Workers)
    └── wrangler.toml     # Binds to same D1/KV/Vectorize + Resend API key
```

### Data Layer Sharing

Both Workers bind to the **same** Cloudflare resources by ID:

| Resource | Binding | Shared Data |
|----------|---------|-------------|
| D1 | `TREND_DB` | trend-skill: `api_keys` table; web: `users`, `magic_links`, `contents` tables |
| KV | `TREND_KV` | trend-skill writes `trends:*` keys; web reads them + writes `session:*` keys |
| Vectorize | `TREND_VECTORIZE` | trend-skill writes type:"trend" vectors; web writes type:"content" vectors |
| AI | `AI` | Both use `@cf/baai/bge-base-en-v1.5` for embeddings |

### Change to trend-skill

One change: add `type: "trend"` to Vectorize metadata on upsert. This lets the new app filter content vs trend vectors in the shared index.

## Data Model

### D1 Tables (new, in shared trend-skill-db)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
);

CREATE TABLE contents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT DEFAULT 'new',
  file_modified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_contents_user_id ON contents(user_id);
CREATE INDEX idx_contents_status ON contents(status);
```

### Vectorize Metadata (content vectors)

```json
{
  "type": "content",
  "user_id": "abc123",
  "content_id": "xyz789",
  "title": "My Article Title",
  "timestamp_ms": 1714300000000
}
```

Embedding text: `title | summary` concatenated.

### Content Status Enum

- `new` — just imported, not reviewed
- `pending` — marked for publishing
- `published` — already published
- `ignored` — not relevant

## Authentication

### Magic Link Flow

1. User enters email → `POST /api/auth/login`
2. Worker generates crypto-random token, stores in `magic_links` (15 min expiry)
3. Sends email via Resend API: link `https://{domain}/auth/verify?token=xxx`
4. User clicks → `GET /api/auth/verify?token=xxx`
5. Worker validates token (not expired, not used) → marks used
6. Creates/finds `users` record by email
7. Creates session in KV: `session:{sessionId}` → `{userId, email, expiresAt}` (7-day TTL)
8. Returns `Set-Cookie: session={sessionId}; HttpOnly; Secure; SameSite=Lax`

### Session Middleware

Every authenticated request reads session cookie → looks up KV `session:{id}` → attaches user to request context. Expired/missing → 401.

### Email Service

Resend (free tier: 100 emails/day, 3,000/month). Single HTTP POST per email, no SDK needed.

## Content Import

### Browser Interaction

Two import methods, both in the Content Library page:

1. **Folder picker**: Click button → File System Access API / `<input webkitdirectory>` → selects folder → shows all `.md` files
2. **Drag and drop**: Drag files/folder onto drop zone

### Import Flow

1. Browser reads `.md` files client-side using FileReader API
2. For each file, extract:
   - `filename`: original file name
   - `title`: `filename` + first `# heading` (e.g. "my-post.md — Introduction to AI")
   - `summary`: first 200 characters of body text (after stripping markdown syntax)
   - `file_modified_at`: from File.lastModified
3. Sort by `file_modified_at` descending (most recent first)
4. Show preview list to user → click "Confirm Import"
5. `POST /api/contents/import` with array of `{filename, title, summary, file_modified_at}`
6. Worker stores metadata in D1 `contents` table
7. Worker generates embeddings for each content via AI binding (`title | summary`)
8. Worker upserts vectors to Vectorize with metadata `{type: "content", user_id, content_id, title}`
9. Worker triggers recommendation calculation for new content

### Deduplication

On import, check D1 for existing content with same `user_id` + `filename`. If exists, update metadata and re-embed. If new, insert.

## Content-Trend Recommendation

### Trigger Points

1. **On content import**: immediately after embedding, match new content against trends
2. **On daily trend update**: trend-skill webhook notifies web Worker → re-match all users' content

### Matching Algorithm

For each content item:
1. Get the content's embedding vector:
   - **On import**: reuse the vector just generated for Vectorize upsert
   - **On daily re-match**: fetch vector from Vectorize by content vector ID (`getByIds`)
2. Query Vectorize with that vector: `filter: {type: "trend"}`, `topK: 5`
3. Each result includes trend title, score, similarity from Vectorize response
4. Store top matches in KV: `recommendations:{user_id}` → JSON array of `{content_id, matches: [{trend_id, title, similarity}]}`

### Display

Home page shows **Top 5 content** ranked by highest similarity score across all their trend matches. Each content card expands to show matched trends with similarity scores. Users can mark content status directly from the recommendation view.

### Webhook Endpoint

`POST /api/webhook/trend-update` — authenticated with HMAC signature (shared secret with trend-skill). On receive:
1. Iterate all users (paginated D1 query)
2. For each user's content, re-run matching
3. Update KV recommendations cache

## API Routes (web Worker)

### Auth
- `POST /api/auth/login` — send Magic Link
- `GET /api/auth/verify` — verify token, create session
- `POST /api/auth/logout` — delete session
- `GET /api/auth/me` — current user info

### Content
- `POST /api/contents/import` — batch import content metadata
- `GET /api/contents` — list user's content (sorted by file_modified_at desc)
- `PATCH /api/contents/:id` — update title, summary, or status
- `DELETE /api/contents/:id` — delete content + vector

### Recommendations
- `GET /api/recommendations` — get user's top 5 content-trend matches

### Webhook
- `POST /api/webhook/trend-update` — receive trend-skill daily digest webhook

## Frontend Pages

React + Vite SPA with shadcn/ui + Tailwind CSS. Deployed to Cloudflare Pages.

### Routes

| Path | Page | Auth |
|------|------|:----:|
| `/login` | Email input + Magic Link sent confirmation | No |
| `/auth/verify` | Token verification + redirect to `/` | No |
| `/` | Home — Top 5 recommended content with trend matches | Yes |
| `/contents` | Content library — list, import, edit, status marking | Yes |

### Home / Recommendations Page

- Card list of top 5 content items, sorted by best match score
- Each card: title, summary preview, highest similarity %, status badge
- Expand card → list of matched trends (trend title, platform, similarity %)
- Quick-action: change status (dropdown: new/pending/published/ignored)

### Content Library Page

- Import zone: drag-and-drop area + "Select Folder" button
- Pre-import preview: file list sorted by modification time, confirm button
- Content list: sortable table (title, status, modified date, created date)
- Inline edit: click title/summary to edit → save → re-embed
- Status dropdown on each row
- Delete button

## Free Tier Budget

| Service | Usage Estimate | Free Limit | Headroom |
|---------|---------------|------------|----------|
| Workers requests | ~1,000/day (small user base) | 100,000/day | Large |
| D1 storage | < 50 MB | 5 GB | Large |
| D1 reads | ~5,000/day | 5M/day | Large |
| D1 writes | ~200/day | 100K/day | Large |
| KV reads | ~2,000/day | 100K/day | Large |
| KV writes | ~100/day | 1,000/day | Moderate |
| Vectorize stored dims | ~3,000 trends + ~3,000 content × 768 = ~4.6M | 5M dims | Tight |
| Vectorize queries | ~500/day × 768 = ~384K dims/day | 30M/month | OK |
| AI inference | ~50 embed calls/day | 10,000 neurons/day | OK |
| Resend emails | ~10/day | 100/day | Large |
| Pages | Static SPA | Unlimited | N/A |

**Key constraint**: Vectorize stored dimensions (5M free). With 768-dim model, ~6,500 vectors total. Trends use ~3,000; leaves ~3,500 for content across all users. Sufficient for MVP.

## Project Structure

```
web/
├── src/                    # React SPA
│   ├── components/         # shadcn/ui components
│   ├── pages/              # Login, Home, Contents
│   ├── hooks/              # useAuth, useContents, useRecommendations
│   ├── lib/                # API client, markdown parser, file reader
│   └── main.tsx
├── worker/                 # Hono backend
│   ├── api/
│   │   ├── auth.ts         # Magic Link login/verify/logout
│   │   ├── contents.ts     # CRUD + import
│   │   ├── recommendations.ts  # Top 5 matches
│   │   └── webhook.ts      # Trend update handler
│   ├── auth/
│   │   ├── session.ts      # KV session management
│   │   └── middleware.ts   # Cookie-based auth middleware
│   ├── services/
│   │   ├── email.ts        # Resend integration
│   │   ├── content.ts      # D1 content CRUD + Vectorize embed
│   │   └── recommend.ts    # Matching algorithm
│   ├── index.ts            # Hono app entry
│   └── types.ts
├── migrations/
│   ├── 0001_create_users.sql
│   ├── 0002_create_magic_links.sql
│   └── 0003_create_contents.sql
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
└── wrangler.toml
```

## Verification

1. `npm run dev` — Vite dev server + wrangler dev in parallel
2. Register with email → receive Magic Link → click to login → session persists
3. Import .md folder → see files listed by modification time → confirm → content appears in library
4. Edit title/summary → verify Vectorize re-embed
5. Home page shows top 5 content with trend matches after import
6. Trigger trend-skill cron → webhook fires → recommendations refresh
7. Status marking works across both pages
8. `npm test` — all worker tests pass
