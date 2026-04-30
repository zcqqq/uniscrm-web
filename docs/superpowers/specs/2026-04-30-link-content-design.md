# link-content Module Design

## Context

The existing web/ module contains a content management feature (/content page) that allows users to import local .md files, manage them via CRUD operations, and generate embeddings for trend matching. This design extracts all content functionality into a standalone `link-content` Worker + SPA module, adds Notion as a second content channel alongside Local, and introduces a unified multi-channel data model with `channel_type` discrimination.

**Goals:**
- Complete extraction: link-content is a fully independent Cloudflare Worker with its own React SPA
- Unified data model: all channels share the same `content_items` table, differentiated by `channel_type`
- Channel plugin architecture: new channels can be added by implementing a `ContentChannel` interface
- Delete all content-related code from web/

## Data Model

### content_items (replaces old `contents` table)

```sql
CREATE TABLE content_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,           -- 'LOCAL' | 'NOTION'
  channel_source_id TEXT NOT NULL,      -- Local: relative file path; Notion: page_id
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT DEFAULT 'new',            -- new | pending | published | ignored
  source_url TEXT,                      -- Notion page URL; Local: null
  source_modified_at TEXT,              -- Channel-side last modified time
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_ci_user ON content_items(user_id);
CREATE INDEX idx_ci_status ON content_items(status);
CREATE UNIQUE INDEX idx_ci_user_channel_source
  ON content_items(user_id, channel_type, channel_source_id);
```

### channel_configs (user's per-channel settings)

```sql
CREATE TABLE channel_configs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,
  config TEXT NOT NULL,                 -- JSON: Local: { folder_name }; Notion: { folder_ids: [...] }
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, channel_type)
);
```

### oauth_tokens (OAuth credentials)

```sql
CREATE TABLE oauth_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,               -- 'notion'
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at TEXT,
  workspace_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, provider)
);
```

### Key changes from old `contents` table
- `filename` -> `channel_source_id` (generic: Notion uses page_id, Local uses file path)
- `file_modified_at` -> `source_modified_at` (generic name)
- Added `channel_type`, `source_url`
- Unique index changed to `(user_id, channel_type, channel_source_id)`

## Architecture

### ContentChannel Interface

```typescript
// channels/interface.ts
type ChannelType = 'LOCAL' | 'NOTION';

interface ChannelItem {
  channel_source_id: string;
  title: string;
  summary: string | null;
  source_url: string | null;
  source_modified_at: string | null;
}

interface ContentChannel {
  type: ChannelType;
  fetchItems(config: ChannelConfig): Promise<ChannelItem[]>;
  requiresAuth(): boolean;
}
```

### Channel Differences

| Aspect | Local | Notion |
|--------|-------|--------|
| Data source | Browser-side file parsing | Server-side Notion API |
| `channel_source_id` | Relative file path | Notion page_id |
| `source_url` | null | Notion page URL |
| `source_modified_at` | File.lastModified | Notion last_edited_time |
| OAuth | Not required | Required |
| Sync trigger | User selects folder -> frontend parses -> POST to backend | User clicks "sync" -> backend calls Notion API |

### Unified Incremental Sync Strategy

Both channels use the same `ContentService.syncBatch()` method:

1. Receive `items[]` with `channel_type`
2. Query existing `content_items` for this user + channel_type
3. For each incoming item, match by `channel_source_id`:
   - `source_modified_at` unchanged -> skip
   - `source_modified_at` changed -> update title/summary/source_modified_at
   - New `channel_source_id` -> insert
4. Generate embeddings for new/updated items
5. Upsert into Vectorize

## API Routes

### Content CRUD
```
POST   /api/contents/sync            -- Unified sync: { channel_type, items[] }
GET    /api/contents                  -- List user content (filter by ?channel_type=)
PATCH  /api/contents/:id             -- Update (title/summary/status)
DELETE /api/contents/:id             -- Delete
```

### Notion Channel
```
GET    /api/channels/notion/auth     -- Initiate Notion OAuth
GET    /api/channels/notion/callback -- OAuth callback handler
GET    /api/channels/notion/status   -- Authorization status check
GET    /api/channels/notion/folders  -- List Notion databases/pages
POST   /api/channels/notion/sync    -- Trigger Notion sync
```

### Channel Config
```
GET    /api/channels/:type/config    -- Get channel config
PUT    /api/channels/:type/config    -- Save channel config
```

## Notion OAuth Flow

### First-time authorization
1. User clicks Notion icon -> `GET /api/channels/notion/auth`
2. Redirect to Notion OAuth consent page
3. User authorizes -> callback to `/api/channels/notion/callback`
4. Backend exchanges code for access_token, stores in `oauth_tokens`
5. Frontend refreshes, Notion shows as authorized

### Folder selection
1. Click "Select" button -> `GET /api/channels/notion/folders`
2. Backend calls Notion API `POST /v1/search` with access_token to list databases/pages
3. Frontend displays folder list, user multi-selects
4. Click "Confirm" -> `PUT /api/channels/notion/config` saves selection
5. Auto-triggers one sync after saving

### Manual sync
1. Click "Sync" button -> `POST /api/channels/notion/sync`
2. Backend reads `channel_configs` for selected folder IDs
3. For each folder, call Notion API to get child pages' title + last_edited_time
4. Call `ContentService.syncBatch()` for incremental sync
5. Return sync result (added/updated/skipped counts)

## Frontend Design

### Page Structure

```
/content page
+-- Top: Channel Zone
|   +-- Local icon + "Select Folder" button
|   +-- Notion icon
|       +-- Unauthorized: click to OAuth
|       +-- Authorized: "Select" button + "Sync" button
+-- Middle: Unified ContentTable
|   +-- Sorted by source_modified_at DESC
|   +-- Shows channel_type label (Local / Notion)
|   +-- Status, edit, delete actions
+-- Bottom: Pagination (if needed)
```

### Components
- `LocalImport.tsx` - Folder picker via `<input webkitdirectory>`, drag-drop zone, .md parsing, preview before sync
- `NotionConnect.tsx` - OAuth status display, folder selection modal, sync button with progress
- `ContentTable.tsx` - Unified table for all channels, channel type badge, inline editing, status dropdown

## Project Structure

```
link-content/
├── src/
│   ├── index.ts                      # Hono app + Worker entry
│   ├── types.ts                      # Type definitions
│   ├── channels/
│   │   ├── interface.ts              # ContentChannel interface + ChannelType
│   │   └── notion.ts                 # Notion API wrapper
│   ├── services/
│   │   ├── content.ts                # Unified storage (D1 + Vectorize + AI)
│   │   └── oauth.ts                  # OAuth token CRUD
│   ├── auth/
│   │   ├── middleware.ts             # Session auth middleware (shared D1 users)
│   │   └── session.ts               # Session read from KV
│   ├── api/
│   │   ├── contents.ts              # Content CRUD routes
│   │   └── channels.ts              # Channel management routes
│   └── lib/
│       └── markdown.ts              # Markdown parser (migrated from web/)
├── frontend/
│   ├── main.tsx
│   ├── App.tsx
│   ├── pages/
│   │   └── Content.tsx              # Main page
│   ├── components/
│   │   ├── LocalImport.tsx          # Local folder import
│   │   ├── NotionConnect.tsx        # Notion auth + folder select + sync
│   │   └── ContentTable.tsx         # Unified content list
│   ├── hooks/
│   │   └── useContents.ts           # Content management hook
│   └── lib/
│       ├── api.ts                   # HTTP client
│       └── markdown.ts              # Frontend MD parsing
├── migrations/
│   ├── 0001_create_content_items.sql
│   ├── 0002_create_channel_configs.sql
│   └── 0003_create_oauth_tokens.sql
├── tests/
│   ├── services/content.test.ts
│   ├── services/oauth.test.ts
│   ├── api/contents.test.ts
│   ├── api/channels.test.ts
│   └── channels/notion.test.ts
├── package.json
├── wrangler.toml
├── vite.config.ts
└── tsconfig.json
```

## Shared Resources

link-content connects to the same Cloudflare bindings as web/:

- **D1**: Same database (shared `users` table, new `content_items`/`channel_configs`/`oauth_tokens` tables)
- **KV**: Same namespace (session management)
- **Vectorize**: Same index (content embeddings with `type: "content"` metadata)
- **AI**: Same binding (`@cf/baai/bge-base-en-v1.5` for embeddings)

Authentication reuses the shared `users` table and KV session tokens from web/.

## Cleanup: web/ Module

Delete the following files from web/:
- `src/pages/Contents.tsx`
- `src/components/ImportZone.tsx`
- `src/components/ContentTable.tsx`
- `src/hooks/useContents.ts`
- `src/lib/markdown.ts`
- `worker/api/contents.ts`
- `worker/services/content.ts`
- Remove content-related routes from `worker/index.ts`
- Remove `ContentItem`, `ContentMatch` types from `worker/types.ts`
- Remove content API methods from `src/lib/api.ts`

## Verification

1. **Database migrations**: Run `wrangler d1 migrations apply` and verify all 3 tables created
2. **Local import flow**: Select a folder with .md files -> preview -> confirm -> verify items appear in ContentTable with channel_type=LOCAL
3. **Incremental sync (Local)**: Re-import same folder -> verify unchanged files are skipped, modified files are updated
4. **Notion OAuth**: Click Notion icon -> complete OAuth -> verify token stored in oauth_tokens
5. **Notion folder selection**: Select folders -> save config -> verify auto-sync triggers
6. **Notion sync**: Click sync button -> verify items appear with channel_type=NOTION
7. **Notion incremental**: Sync again without Notion changes -> verify all skipped
8. **Embedding**: Verify new/updated items have embeddings in Vectorize with `type: "content"` metadata
9. **web/ cleanup**: Verify web/ still builds and runs without content-related code; /content route removed
10. **Unified list**: Verify ContentTable shows both Local and Notion items sorted by source_modified_at
