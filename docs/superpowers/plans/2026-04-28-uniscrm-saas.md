# UniSCRM SaaS Web App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a web SaaS portal where users log in via email Magic Link, import local `.md` files as content, and see which content best matches current social media trends.

**Architecture:** New independent Worker (`web/worker/`) + React SPA (`web/src/`) sharing the same D1/KV/Vectorize bindings as the existing `trend-skill/`. One small change to trend-skill: add `type: "trend"` to Vectorize metadata. Frontend deployed to Cloudflare Pages, backend as a separate Worker.

**Tech Stack:** Hono 4.7, React 19, Vite, shadcn/ui, Tailwind CSS 4, Resend (email), Cloudflare Workers/Pages/D1/KV/Vectorize/AI

**Spec:** `docs/superpowers/specs/2026-04-28-uniscrm-saas-design.md`

---

### Task 0: Add `type: "trend"` to trend-skill Vectorize metadata

**Files:**
- Modify: `trend-skill/src/storage/vectorize.ts:27-36`
- Modify: `trend-skill/tests/storage/vectorize.test.ts:57-68`

- [ ] **Step 1: Update the test to expect `type: "trend"` in metadata**

In `trend-skill/tests/storage/vectorize.test.ts`, update the `upsertTrends` test:

```typescript
      expect(vectorize.upsert).toHaveBeenCalledWith([
        expect.objectContaining({
          id: items[0].id,
          values: [0.1, 0.2, 0.3],
          metadata: expect.objectContaining({
            type: "trend",
            platform: "twitter",
            location: "global",
            language: "en",
            date: "2026-04-28",
            title: "AI Topic",
          }),
        }),
      ]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd trend-skill && npx vitest run tests/storage/vectorize.test.ts`
Expected: FAIL — metadata missing `type` field

- [ ] **Step 3: Add `type: "trend"` to metadata in vectorize.ts**

In `trend-skill/src/storage/vectorize.ts`, line 27-36, add `type: "trend"` as the first metadata field:

```typescript
    const records = items.map((item, i) => ({
      id: item.id,
      values: embedResult.data[i],
      metadata: {
        type: "trend",
        platform: item.platform,
        location: item.location,
        language: item.language,
        timestamp_ms: new Date(item.timestamp).getTime(),
        date: item.timestamp.slice(0, 10),
        categories: JSON.stringify(item.categories),
        title: item.title,
        item: JSON.stringify(item),
      },
    }));
```

- [ ] **Step 4: Run all trend-skill tests to verify nothing breaks**

Run: `cd trend-skill && npx vitest run`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add trend-skill/src/storage/vectorize.ts trend-skill/tests/storage/vectorize.test.ts
git commit -m "feat(trend): add type:trend to Vectorize metadata for content filtering"
```

---

### Task 1: Scaffold web project with Hono Worker + React SPA

**Files:**
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/wrangler.toml`
- Create: `web/vitest.config.ts`
- Create: `web/vite.config.ts`
- Create: `web/tailwind.config.ts`
- Create: `web/worker/index.ts`
- Create: `web/worker/types.ts`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/index.html`

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "uniscrm-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "dev:worker": "wrangler dev --env dev",
    "build": "vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "hono": "^4.7.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0"
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

- [ ] **Step 2: Create `web/wrangler.toml`**

Binds to the same D1, KV, Vectorize, and AI as trend-skill, using identical IDs.

```toml
name = "uniscrm-web"
main = "worker/index.ts"
compatibility_date = "2025-04-01"
compatibility_flags = ["nodejs_compat"]

[observability]
enabled = true
head_sampling_rate = 1

[env.dev]
name = "uniscrm-web-dev"

[[env.dev.kv_namespaces]]
binding = "KV"
id = "ac8b64b59ac540e0ab482f25bb78d41e"

[[env.dev.d1_databases]]
binding = "DB"
database_name = "trend-skill-db-dev"
database_id = "b322777d-6617-4dbf-a4d2-f734166b7737"

[[env.dev.vectorize]]
binding = "VECTORIZE"
index_name = "trend-embeddings-dev"

[env.dev.ai]
binding = "AI"

[env.production]
name = "uniscrm-web"

[[env.production.kv_namespaces]]
binding = "KV"
id = "<prod-kv-id>"

[[env.production.d1_databases]]
binding = "DB"
database_name = "trend-skill-db"
database_id = "<prod-d1-id>"

[[env.production.vectorize]]
binding = "VECTORIZE"
index_name = "trend-embeddings"

[env.production.ai]
binding = "AI"
```

- [ ] **Step 3: Create `web/worker/types.ts`**

```typescript
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  RESEND_API_KEY: string;
  WEBHOOK_SECRET: string;
  APP_URL: string;
}

export interface User {
  id: string;
  email: string;
  created_at: string;
}

export interface ContentItem {
  id: string;
  user_id: string;
  filename: string;
  title: string;
  summary: string | null;
  status: "new" | "pending" | "published" | "ignored";
  file_modified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContentMatch {
  content_id: string;
  title: string;
  matches: TrendMatch[];
}

export interface TrendMatch {
  trend_id: string;
  title: string;
  platform: string;
  location: string;
  similarity: number;
}

export interface Session {
  user_id: string;
  email: string;
  expires_at: string;
}
```

- [ ] **Step 4: Create `web/worker/index.ts` with health endpoint**

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*", credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

export default {
  fetch: app.fetch,
};
```

- [ ] **Step 5: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["@cloudflare/workers-types/2023-07-01", "vite/client"]
  },
  "include": ["src", "worker"]
}
```

- [ ] **Step 6: Create `web/vitest.config.ts`**

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml", environment: "dev" },
      },
    },
  },
});
```

- [ ] **Step 7: Create minimal React SPA files**

`web/vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:8788",
    },
  },
});
```

`web/tailwind.config.ts`:
```typescript
import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}"],
} satisfies Config;
```

`web/index.html`:
```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>UniSCRM</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`:
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

`web/src/index.css`:
```css
@import "tailwindcss";
```

`web/src/App.tsx`:
```tsx
export function App() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <h1 className="text-2xl font-bold">UniSCRM</h1>
    </div>
  );
}
```

- [ ] **Step 8: Install dependencies and verify**

```bash
cd web && npm install
```

- [ ] **Step 9: Verify worker starts**

```bash
cd web && npx wrangler dev --env dev --port 8788
```

Expected: Worker starts, `GET /health` returns `{"status":"ok"}`

- [ ] **Step 10: Verify frontend starts**

```bash
cd web && npm run dev
```

Expected: Vite dev server starts, shows "UniSCRM" heading in browser

- [ ] **Step 11: Commit**

```bash
git add web/
git commit -m "feat(web): scaffold project with Hono Worker + React SPA"
```

---

### Task 2: D1 migrations for users, magic_links, contents tables

**Files:**
- Create: `web/migrations/0001_create_users.sql`
- Create: `web/migrations/0002_create_magic_links.sql`
- Create: `web/migrations/0003_create_contents.sql`

- [ ] **Step 1: Create `web/migrations/0001_create_users.sql`**

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);
```

- [ ] **Step 2: Create `web/migrations/0002_create_magic_links.sql`**

```sql
CREATE TABLE magic_links (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
);

CREATE INDEX idx_magic_links_email ON magic_links(email);
```

- [ ] **Step 3: Create `web/migrations/0003_create_contents.sql`**

```sql
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
CREATE UNIQUE INDEX idx_contents_user_filename ON contents(user_id, filename);
```

- [ ] **Step 4: Apply migrations to dev D1**

```bash
cd web && npx wrangler d1 migrations apply trend-skill-db-dev --env dev
```

Expected: All 3 migrations applied successfully

- [ ] **Step 5: Verify tables exist**

```bash
cd web && npx wrangler d1 execute trend-skill-db-dev --env dev --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expected: Output includes `api_keys`, `contents`, `magic_links`, `users`

- [ ] **Step 6: Commit**

```bash
git add web/migrations/
git commit -m "feat(web): add D1 migrations for users, magic_links, contents"
```

---

### Task 3: Magic Link auth — session service + middleware

**Files:**
- Create: `web/worker/auth/session.ts`
- Create: `web/worker/auth/middleware.ts`
- Create: `web/tests/auth/session.test.ts`
- Create: `web/tests/auth/middleware.test.ts`

- [ ] **Step 1: Write failing test for session service**

Create `web/tests/auth/session.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionService } from "../../worker/auth/session";

describe("SessionService", () => {
  let kv: any;
  let service: SessionService;

  beforeEach(() => {
    kv = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    service = new SessionService(kv);
  });

  describe("create", () => {
    it("stores session in KV with 7-day TTL", async () => {
      const session = await service.create("user-1", "test@example.com");

      expect(session).toMatch(/^[a-z0-9-]+$/);
      expect(kv.put).toHaveBeenCalledWith(
        `session:${session}`,
        expect.stringContaining('"user_id":"user-1"'),
        { expirationTtl: 604800 }
      );
    });
  });

  describe("get", () => {
    it("returns session data when valid", async () => {
      const data = JSON.stringify({
        user_id: "user-1",
        email: "test@example.com",
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      });
      kv.get.mockResolvedValue(data);

      const result = await service.get("session-id");

      expect(result).toEqual(expect.objectContaining({ user_id: "user-1" }));
    });

    it("returns null when session not found", async () => {
      const result = await service.get("missing");
      expect(result).toBeNull();
    });
  });

  describe("destroy", () => {
    it("deletes session from KV", async () => {
      await service.destroy("session-id");
      expect(kv.delete).toHaveBeenCalledWith("session:session-id");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/auth/session.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SessionService**

Create `web/worker/auth/session.ts`:

```typescript
import type { Session } from "../types";

const SESSION_TTL = 7 * 24 * 60 * 60; // 7 days in seconds

export class SessionService {
  constructor(private kv: KVNamespace) {}

  async create(userId: string, email: string): Promise<string> {
    const sessionId = crypto.randomUUID();
    const session: Session = {
      user_id: userId,
      email,
      expires_at: new Date(Date.now() + SESSION_TTL * 1000).toISOString(),
    };
    await this.kv.put(`session:${sessionId}`, JSON.stringify(session), {
      expirationTtl: SESSION_TTL,
    });
    return sessionId;
  }

  async get(sessionId: string): Promise<Session | null> {
    const data = await this.kv.get(`session:${sessionId}`);
    if (!data) return null;
    return JSON.parse(data) as Session;
  }

  async destroy(sessionId: string): Promise<void> {
    await this.kv.delete(`session:${sessionId}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/auth/session.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for auth middleware**

Create `web/tests/auth/middleware.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../../worker/auth/middleware";

describe("authMiddleware", () => {
  let kv: any;
  let app: Hono;

  beforeEach(() => {
    kv = {
      get: vi.fn().mockResolvedValue(null),
    };
    app = new Hono();
    app.use("/*", (c, next) => {
      (c.env as any) = { KV: kv };
      return next();
    });
    app.use("/*", authMiddleware);
    app.get("/test", (c) => {
      const userId = c.get("userId" as never);
      return c.json({ userId });
    });
  });

  it("returns 401 when no session cookie", async () => {
    const res = await app.request("/test");
    expect(res.status).toBe(401);
  });

  it("returns 401 when session not found in KV", async () => {
    const res = await app.request("/test", {
      headers: { Cookie: "session=invalid-id" },
    });
    expect(res.status).toBe(401);
  });

  it("attaches userId to context when session valid", async () => {
    kv.get.mockResolvedValue(
      JSON.stringify({
        user_id: "user-1",
        email: "test@example.com",
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      })
    );
    const res = await app.request("/test", {
      headers: { Cookie: "session=valid-id" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("user-1");
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd web && npx vitest run tests/auth/middleware.test.ts`
Expected: FAIL — module not found

- [ ] **Step 7: Implement auth middleware**

Create `web/worker/auth/middleware.ts`:

```typescript
import { getCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import { SessionService } from "./session";
import type { Env } from "../types";

export async function authMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  const sessionId = getCookie(c, "session");
  if (!sessionId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const sessions = new SessionService(c.env.KV);
  const session = await sessions.get(sessionId);
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("userId" as never, session.user_id);
  c.set("email" as never, session.email);
  await next();
}
```

- [ ] **Step 8: Run both test files**

Run: `cd web && npx vitest run tests/auth/`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
git add web/worker/auth/ web/tests/auth/
git commit -m "feat(web): add session service and auth middleware"
```

---

### Task 4: Magic Link auth — login, verify, logout API routes

**Files:**
- Create: `web/worker/services/email.ts`
- Create: `web/worker/api/auth.ts`
- Create: `web/tests/services/email.test.ts`
- Create: `web/tests/api/auth.test.ts`

- [ ] **Step 1: Write failing test for email service**

Create `web/tests/services/email.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmailService } from "../../worker/services/email";

describe("EmailService", () => {
  let fetchSpy: any;
  let service: EmailService;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(new Response('{"id":"msg-1"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    service = new EmailService("re_test_key", "https://app.example.com");
  });

  it("sends magic link email via Resend API", async () => {
    await service.sendMagicLink("user@example.com", "token123");

    expect(fetchSpy).toHaveBeenCalledWith("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer re_test_key",
      },
      body: expect.stringContaining("token123"),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/services/email.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement EmailService**

Create `web/worker/services/email.ts`:

```typescript
export class EmailService {
  constructor(
    private apiKey: string,
    private appUrl: string
  ) {}

  async sendMagicLink(email: string, token: string): Promise<void> {
    const link = `${this.appUrl}/auth/verify?token=${token}`;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        from: "UniSCRM <noreply@uniscrm.com>",
        to: [email],
        subject: "Sign in to UniSCRM",
        html: `<p>Click <a href="${link}">here</a> to sign in. This link expires in 15 minutes.</p>`,
      }),
    });
    if (!response.ok) {
      throw new Error(`Resend API error: ${response.status}`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/services/email.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for auth routes**

Create `web/tests/api/auth.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createAuthRouter } from "../../worker/api/auth";

describe("auth routes", () => {
  let db: any;
  let kv: any;
  let app: Hono;

  beforeEach(() => {
    db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
          run: vi.fn().mockResolvedValue({}),
        }),
      }),
    };
    kv = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"id":"msg"}', { status: 200 })));
    app = new Hono();
    app.use("/*", (c, next) => {
      (c.env as any) = {
        DB: db,
        KV: kv,
        RESEND_API_KEY: "re_test",
        APP_URL: "https://app.example.com",
      };
      return next();
    });
    app.route("/auth", createAuthRouter());
  });

  describe("POST /auth/login", () => {
    it("returns 400 for missing email", async () => {
      const res = await app.request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("creates magic link and sends email", async () => {
      const res = await app.request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.com" }),
      });
      expect(res.status).toBe(200);
      expect(db.prepare).toHaveBeenCalled();
    });
  });

  describe("GET /auth/verify", () => {
    it("returns 400 for missing token", async () => {
      const res = await app.request("/auth/verify");
      expect(res.status).toBe(400);
    });

    it("returns 401 for invalid token", async () => {
      const res = await app.request("/auth/verify?token=bad");
      expect(res.status).toBe(401);
    });

    it("creates session and returns cookie for valid token", async () => {
      const future = new Date(Date.now() + 900000).toISOString();
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn()
            .mockResolvedValueOnce({ token: "tok", email: "u@e.com", expires_at: future, used: 0 })
            .mockResolvedValueOnce({ id: "user-1", email: "u@e.com" }),
          run: vi.fn().mockResolvedValue({}),
        }),
      });

      const res = await app.request("/auth/verify?token=tok");
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("session=");
    });
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `cd web && npx vitest run tests/api/auth.test.ts`
Expected: FAIL — module not found

- [ ] **Step 7: Implement auth routes**

Create `web/worker/api/auth.ts`:

```typescript
import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { SessionService } from "../auth/session";
import { EmailService } from "../services/email";

export function createAuthRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/login", async (c) => {
    const body = await c.req.json<{ email?: string }>();
    if (!body.email) {
      return c.json({ error: "Email is required" }, 400);
    }

    const token = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    await c.env.DB.prepare("INSERT INTO magic_links (token, email, expires_at) VALUES (?, ?, ?)")
      .bind(token, body.email, expiresAt)
      .run();

    const emailService = new EmailService(c.env.RESEND_API_KEY, c.env.APP_URL);
    await emailService.sendMagicLink(body.email, token);

    return c.json({ ok: true });
  });

  router.get("/verify", async (c) => {
    const token = c.req.query("token");
    if (!token) {
      return c.json({ error: "Token is required" }, 400);
    }

    const link = await c.env.DB.prepare("SELECT * FROM magic_links WHERE token = ?")
      .bind(token)
      .first<{ token: string; email: string; expires_at: string; used: number }>();

    if (!link || link.used || new Date(link.expires_at) < new Date()) {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    await c.env.DB.prepare("UPDATE magic_links SET used = 1 WHERE token = ?")
      .bind(token)
      .run();

    let user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?")
      .bind(link.email)
      .first<{ id: string; email: string }>();

    if (!user) {
      const userId = crypto.randomUUID();
      await c.env.DB.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)")
        .bind(userId, link.email, new Date().toISOString())
        .run();
      user = { id: userId, email: link.email };
    }

    const sessions = new SessionService(c.env.KV);
    const sessionId = await sessions.create(user.id, user.email);

    setCookie(c, "session", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });

    return c.json({ ok: true, user: { id: user.id, email: user.email } });
  });

  router.post("/logout", async (c) => {
    const sessionId = c.req.header("Cookie")?.match(/session=([^;]+)/)?.[1];
    if (sessionId) {
      const sessions = new SessionService(c.env.KV);
      await sessions.destroy(sessionId);
    }
    deleteCookie(c, "session", { path: "/" });
    return c.json({ ok: true });
  });

  router.get("/me", async (c) => {
    const sessionId = c.req.header("Cookie")?.match(/session=([^;]+)/)?.[1];
    if (!sessionId) return c.json({ error: "Unauthorized" }, 401);

    const sessions = new SessionService(c.env.KV);
    const session = await sessions.get(sessionId);
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    return c.json({ user: { id: session.user_id, email: session.email } });
  });

  return router;
}
```

- [ ] **Step 8: Wire auth routes into main app**

In `web/worker/index.ts`, add:

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { createAuthRouter } from "./api/auth";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*", credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/auth", createAuthRouter());

export default {
  fetch: app.fetch,
};
```

- [ ] **Step 9: Run all tests**

Run: `cd web && npx vitest run`
Expected: All tests PASS

- [ ] **Step 10: Commit**

```bash
git add web/worker/services/email.ts web/worker/api/auth.ts web/worker/index.ts web/tests/
git commit -m "feat(web): add Magic Link auth (login, verify, logout, me)"
```

---

### Task 5: Content service — D1 CRUD + Vectorize embedding

**Files:**
- Create: `web/worker/services/content.ts`
- Create: `web/tests/services/content.test.ts`

- [ ] **Step 1: Write failing test for content service**

Create `web/tests/services/content.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContentService } from "../../worker/services/content";

describe("ContentService", () => {
  let db: any;
  let vectorize: any;
  let ai: any;
  let service: ContentService;

  beforeEach(() => {
    db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({}),
        }),
      }),
    };
    vectorize = {
      upsert: vi.fn().mockResolvedValue(undefined),
      deleteByIds: vi.fn().mockResolvedValue(undefined),
      getByIds: vi.fn().mockResolvedValue([]),
    };
    ai = {
      run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }),
    };
    service = new ContentService(db, vectorize, ai);
  });

  describe("importBatch", () => {
    it("inserts content into D1 and upserts embedding into Vectorize", async () => {
      const items = [
        { filename: "post.md", title: "post.md — My Post", summary: "A summary", file_modified_at: "2026-04-28T00:00:00Z" },
      ];

      const results = await service.importBatch("user-1", items);

      expect(results).toHaveLength(1);
      expect(db.prepare).toHaveBeenCalled();
      expect(ai.run).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", {
        text: ["post.md — My Post | A summary"],
      });
      expect(vectorize.upsert).toHaveBeenCalledWith([
        expect.objectContaining({
          metadata: expect.objectContaining({
            type: "content",
            user_id: "user-1",
          }),
        }),
      ]);
    });
  });

  describe("listByUser", () => {
    it("queries D1 for user contents sorted by file_modified_at desc", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({
            results: [{ id: "c1", user_id: "user-1", filename: "a.md", title: "A", status: "new" }],
          }),
        }),
      });

      const results = await service.listByUser("user-1");
      expect(results).toHaveLength(1);
    });
  });

  describe("update", () => {
    it("updates title and re-embeds when title changes", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ id: "c1", user_id: "user-1", title: "Old", summary: "Sum" }),
          run: vi.fn().mockResolvedValue({}),
        }),
      });

      await service.update("c1", "user-1", { title: "New Title" });

      expect(ai.run).toHaveBeenCalled();
      expect(vectorize.upsert).toHaveBeenCalled();
    });

    it("updates status without re-embedding", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ id: "c1", user_id: "user-1", title: "T", summary: "S" }),
          run: vi.fn().mockResolvedValue({}),
        }),
      });

      await service.update("c1", "user-1", { status: "published" });

      expect(ai.run).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("deletes from D1 and Vectorize", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({}),
        }),
      });

      await service.delete("c1", "user-1");

      expect(vectorize.deleteByIds).toHaveBeenCalledWith(["c1"]);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/services/content.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ContentService**

Create `web/worker/services/content.ts`:

```typescript
import type { ContentItem } from "../types";

const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";

interface ImportInput {
  filename: string;
  title: string;
  summary: string | null;
  file_modified_at: string | null;
}

export class ContentService {
  constructor(
    private db: D1Database,
    private vectorize: VectorizeIndex,
    private ai: Ai
  ) {}

  async importBatch(userId: string, items: ImportInput[]): Promise<ContentItem[]> {
    const now = new Date().toISOString();
    const results: ContentItem[] = [];

    for (const item of items) {
      const existing = await this.db
        .prepare("SELECT id FROM contents WHERE user_id = ? AND filename = ?")
        .bind(userId, item.filename)
        .first<{ id: string }>();

      const id = existing?.id ?? crypto.randomUUID();

      if (existing) {
        await this.db
          .prepare("UPDATE contents SET title = ?, summary = ?, file_modified_at = ?, updated_at = ? WHERE id = ?")
          .bind(item.title, item.summary, item.file_modified_at, now, id)
          .run();
      } else {
        await this.db
          .prepare("INSERT INTO contents (id, user_id, filename, title, summary, file_modified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(id, userId, item.filename, item.title, item.summary, item.file_modified_at, now, now)
          .run();
      }

      results.push({
        id, user_id: userId, filename: item.filename, title: item.title,
        summary: item.summary, status: "new", file_modified_at: item.file_modified_at,
        created_at: now, updated_at: now,
      });
    }

    await this.embedContents(userId, results);
    return results;
  }

  async listByUser(userId: string): Promise<ContentItem[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM contents WHERE user_id = ? ORDER BY file_modified_at DESC")
      .bind(userId)
      .all<ContentItem>();
    return results;
  }

  async update(
    id: string,
    userId: string,
    fields: { title?: string; summary?: string; status?: string }
  ): Promise<void> {
    const existing = await this.db
      .prepare("SELECT * FROM contents WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .first<ContentItem>();
    if (!existing) throw new Error("Content not found");

    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); values.push(fields.title); }
    if (fields.summary !== undefined) { sets.push("summary = ?"); values.push(fields.summary); }
    if (fields.status !== undefined) { sets.push("status = ?"); values.push(fields.status); }
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    await this.db
      .prepare(`UPDATE contents SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();

    const needsReEmbed = fields.title !== undefined || fields.summary !== undefined;
    if (needsReEmbed) {
      const updated: ContentItem = {
        ...existing,
        title: fields.title ?? existing.title,
        summary: fields.summary ?? existing.summary,
      };
      await this.embedContents(userId, [updated]);
    }
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM contents WHERE id = ? AND user_id = ?")
      .bind(id, userId)
      .run();
    await this.vectorize.deleteByIds([id]);
  }

  private buildEmbeddingText(item: ContentItem): string {
    const parts = [item.title];
    if (item.summary) parts.push(item.summary);
    return parts.join(" | ");
  }

  private async embedContents(userId: string, items: ContentItem[]): Promise<void> {
    if (items.length === 0) return;

    const texts = items.map((item) => this.buildEmbeddingText(item));
    const embedResult = (await this.ai.run(EMBEDDING_MODEL, { text: texts })) as { data: number[][] };

    const records = items.map((item, i) => ({
      id: item.id,
      values: embedResult.data[i],
      metadata: {
        type: "content",
        user_id: userId,
        content_id: item.id,
        title: item.title,
        timestamp_ms: Date.now(),
      },
    }));

    await this.vectorize.upsert(records);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run tests/services/content.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/worker/services/content.ts web/tests/services/content.test.ts
git commit -m "feat(web): add content service with D1 CRUD and Vectorize embedding"
```

---

### Task 6: Content API routes

**Files:**
- Create: `web/worker/api/contents.ts`
- Create: `web/tests/api/contents.test.ts`
- Modify: `web/worker/index.ts`

- [ ] **Step 1: Write failing test for content routes**

Create `web/tests/api/contents.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createContentsRouter } from "../../worker/api/contents";

describe("content routes", () => {
  let db: any;
  let vectorize: any;
  let ai: any;
  let app: Hono;

  beforeEach(() => {
    db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
          all: vi.fn().mockResolvedValue({ results: [] }),
          run: vi.fn().mockResolvedValue({}),
        }),
      }),
    };
    vectorize = {
      upsert: vi.fn().mockResolvedValue(undefined),
      deleteByIds: vi.fn().mockResolvedValue(undefined),
    };
    ai = {
      run: vi.fn().mockResolvedValue({ data: [[0.1, 0.2, 0.3]] }),
    };

    app = new Hono();
    app.use("/*", (c, next) => {
      (c.env as any) = { DB: db, VECTORIZE: vectorize, AI: ai, KV: {} };
      c.set("userId" as never, "user-1");
      return next();
    });
    app.route("/contents", createContentsRouter());
  });

  describe("POST /contents/import", () => {
    it("imports content items", async () => {
      const res = await app.request("/contents/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ filename: "test.md", title: "test.md — Test", summary: "Hello", file_modified_at: null }],
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
    });
  });

  describe("GET /contents", () => {
    it("lists user content", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [{ id: "c1", title: "T" }] }),
        }),
      });
      const res = await app.request("/contents");
      expect(res.status).toBe(200);
    });
  });

  describe("PATCH /contents/:id", () => {
    it("updates content status", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue({ id: "c1", user_id: "user-1", title: "T", summary: "S" }),
          run: vi.fn().mockResolvedValue({}),
        }),
      });
      const res = await app.request("/contents/c1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "published" }),
      });
      expect(res.status).toBe(200);
    });
  });

  describe("DELETE /contents/:id", () => {
    it("deletes content", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          run: vi.fn().mockResolvedValue({}),
        }),
      });
      const res = await app.request("/contents/c1", { method: "DELETE" });
      expect(res.status).toBe(200);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/api/contents.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement content routes**

Create `web/worker/api/contents.ts`:

```typescript
import { Hono } from "hono";
import type { Env } from "../types";
import { ContentService } from "../services/content";
import { RecommendService } from "../services/recommend";

export function createContentsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/import", async (c) => {
    const userId = c.get("userId" as never) as string;
    const { items } = await c.req.json<{
      items: { filename: string; title: string; summary: string | null; file_modified_at: string | null }[];
    }>();

    const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    const results = await service.importBatch(userId, items);

    const recommend = new RecommendService(c.env.DB, c.env.VECTORIZE, c.env.KV);
    await recommend.computeForUser(userId);

    return c.json({ items: results });
  });

  router.get("/", async (c) => {
    const userId = c.get("userId" as never) as string;
    const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    const items = await service.listByUser(userId);
    return c.json({ items });
  });

  router.patch("/:id", async (c) => {
    const userId = c.get("userId" as never) as string;
    const id = c.req.param("id");
    const fields = await c.req.json<{ title?: string; summary?: string; status?: string }>();

    const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    await service.update(id, userId, fields);
    return c.json({ ok: true });
  });

  router.delete("/:id", async (c) => {
    const userId = c.get("userId" as never) as string;
    const id = c.req.param("id");

    const service = new ContentService(c.env.DB, c.env.VECTORIZE, c.env.AI);
    await service.delete(id, userId);
    return c.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 4: Wire into main app with auth middleware**

Update `web/worker/index.ts`:

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { createAuthRouter } from "./api/auth";
import { createContentsRouter } from "./api/contents";
import { authMiddleware } from "./auth/middleware";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*", credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/auth", createAuthRouter());

app.use("/api/contents/*", authMiddleware);
app.route("/api/contents", createContentsRouter());

export default {
  fetch: app.fetch,
};
```

- [ ] **Step 5: Run all tests**

Run: `cd web && npx vitest run`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add web/worker/api/contents.ts web/tests/api/contents.test.ts web/worker/index.ts
git commit -m "feat(web): add content CRUD API routes"
```

---

### Task 7: Recommendation service + webhook handler

**Files:**
- Create: `web/worker/services/recommend.ts`
- Create: `web/worker/api/recommendations.ts`
- Create: `web/worker/api/webhook.ts`
- Create: `web/tests/services/recommend.test.ts`
- Modify: `web/worker/index.ts`

- [ ] **Step 1: Write failing test for recommendation service**

Create `web/tests/services/recommend.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { RecommendService } from "../../worker/services/recommend";

describe("RecommendService", () => {
  let db: any;
  let vectorize: any;
  let kv: any;
  let service: RecommendService;

  beforeEach(() => {
    db = {
      prepare: vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({ results: [] }),
        }),
      }),
    };
    vectorize = {
      getByIds: vi.fn().mockResolvedValue([]),
      query: vi.fn().mockResolvedValue({ matches: [] }),
    };
    kv = {
      put: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue(null),
    };
    service = new RecommendService(db, vectorize, kv);
  });

  describe("computeForUser", () => {
    it("fetches content vectors, queries trends, and caches results", async () => {
      db.prepare.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          all: vi.fn().mockResolvedValue({
            results: [{ id: "c1", user_id: "u1", title: "My Post" }],
          }),
        }),
      });
      vectorize.getByIds.mockResolvedValue([
        { id: "c1", values: [0.1, 0.2, 0.3] },
      ]);
      vectorize.query.mockResolvedValue({
        matches: [
          { id: "t1", score: 0.92, metadata: { type: "trend", title: "AI Trend", platform: "twitter", location: "global" } },
        ],
      });

      await service.computeForUser("u1");

      expect(vectorize.query).toHaveBeenCalledWith(
        [0.1, 0.2, 0.3],
        expect.objectContaining({
          filter: { type: "trend" },
          topK: 5,
          returnMetadata: "all",
        })
      );
      expect(kv.put).toHaveBeenCalledWith(
        "recommendations:u1",
        expect.stringContaining('"content_id":"c1"')
      );
    });

    it("skips users with no content", async () => {
      await service.computeForUser("u1");
      expect(vectorize.query).not.toHaveBeenCalled();
    });
  });

  describe("getForUser", () => {
    it("returns cached recommendations sorted by best match", async () => {
      kv.get.mockResolvedValue(
        JSON.stringify([
          { content_id: "c1", title: "Post A", matches: [{ trend_id: "t1", title: "T", platform: "twitter", location: "global", similarity: 0.85 }] },
          { content_id: "c2", title: "Post B", matches: [{ trend_id: "t2", title: "T2", platform: "twitter", location: "global", similarity: 0.95 }] },
        ])
      );

      const results = await service.getForUser("u1");
      expect(results[0].content_id).toBe("c2");
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run tests/services/recommend.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement RecommendService**

Create `web/worker/services/recommend.ts`:

```typescript
import type { ContentItem, ContentMatch, TrendMatch } from "../types";

export class RecommendService {
  constructor(
    private db: D1Database,
    private vectorize: VectorizeIndex,
    private kv: KVNamespace
  ) {}

  async computeForUser(userId: string): Promise<void> {
    const { results: contents } = await this.db
      .prepare("SELECT * FROM contents WHERE user_id = ?")
      .bind(userId)
      .all<ContentItem>();

    if (contents.length === 0) return;

    const vectors = await this.vectorize.getByIds(contents.map((c) => c.id));
    const vectorMap = new Map(vectors.map((v) => [v.id, v.values]));

    const recommendations: ContentMatch[] = [];

    for (const content of contents) {
      const values = vectorMap.get(content.id);
      if (!values) continue;

      const result = await this.vectorize.query(values, {
        filter: { type: "trend" },
        topK: 5,
        returnMetadata: "all",
      });

      const matches: TrendMatch[] = result.matches.map((m) => ({
        trend_id: m.id,
        title: (m.metadata?.title as string) ?? "",
        platform: (m.metadata?.platform as string) ?? "",
        location: (m.metadata?.location as string) ?? "",
        similarity: m.score,
      }));

      if (matches.length > 0) {
        recommendations.push({
          content_id: content.id,
          title: content.title,
          matches,
        });
      }
    }

    await this.kv.put(`recommendations:${userId}`, JSON.stringify(recommendations));
  }

  async computeForContent(
    userId: string,
    contentId: string,
    embedding: number[]
  ): Promise<void> {
    const existing = await this.getForUser(userId);
    const result = await this.vectorize.query(embedding, {
      filter: { type: "trend" },
      topK: 5,
      returnMetadata: "all",
    });

    const matches: TrendMatch[] = result.matches.map((m) => ({
      trend_id: m.id,
      title: (m.metadata?.title as string) ?? "",
      platform: (m.metadata?.platform as string) ?? "",
      location: (m.metadata?.location as string) ?? "",
      similarity: m.score,
    }));

    const content = await this.db
      .prepare("SELECT title FROM contents WHERE id = ? AND user_id = ?")
      .bind(contentId, userId)
      .first<{ title: string }>();

    const updated = existing.filter((r) => r.content_id !== contentId);
    if (matches.length > 0) {
      updated.push({ content_id: contentId, title: content?.title ?? "", matches });
    }

    await this.kv.put(`recommendations:${userId}`, JSON.stringify(updated));
  }

  async getForUser(userId: string): Promise<(ContentMatch & { title: string })[]> {
    const cached = await this.kv.get(`recommendations:${userId}`);
    if (!cached) return [];

    const recommendations = JSON.parse(cached) as (ContentMatch & { title: string })[];
    return recommendations.sort((a, b) => {
      const aMax = Math.max(...a.matches.map((m) => m.similarity));
      const bMax = Math.max(...b.matches.map((m) => m.similarity));
      return bMax - aMax;
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run tests/services/recommend.test.ts`
Expected: PASS

- [ ] **Step 5: Implement recommendation and webhook routes**

Create `web/worker/api/recommendations.ts`:

```typescript
import { Hono } from "hono";
import type { Env } from "../types";
import { RecommendService } from "../services/recommend";

export function createRecommendationsRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/", async (c) => {
    const userId = c.get("userId" as never) as string;
    const service = new RecommendService(c.env.DB, c.env.VECTORIZE, c.env.KV);
    const recommendations = await service.getForUser(userId);
    return c.json({ recommendations: recommendations.slice(0, 5) });
  });

  return router;
}
```

Create `web/worker/api/webhook.ts`:

```typescript
import { Hono } from "hono";
import type { Env } from "../types";
import { RecommendService } from "../services/recommend";

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signed = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const expected = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return expected === signature;
}

export function createWebhookRouter() {
  const router = new Hono<{ Bindings: Env }>();

  router.post("/trend-update", async (c) => {
    const signature = c.req.header("X-Webhook-Signature");
    if (!signature) return c.json({ error: "Missing signature" }, 401);

    const body = await c.req.text();
    const valid = await verifySignature(body, signature, c.env.WEBHOOK_SECRET);
    if (!valid) return c.json({ error: "Invalid signature" }, 401);

    const service = new RecommendService(c.env.DB, c.env.VECTORIZE, c.env.KV);

    const { results: users } = await c.env.DB
      .prepare("SELECT id FROM users")
      .all<{ id: string }>();

    for (const user of users) {
      await service.computeForUser(user.id);
    }

    return c.json({ ok: true, users_updated: users.length });
  });

  return router;
}
```

- [ ] **Step 6: Wire into main app**

Update `web/worker/index.ts`:

```typescript
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { createAuthRouter } from "./api/auth";
import { createContentsRouter } from "./api/contents";
import { createRecommendationsRouter } from "./api/recommendations";
import { createWebhookRouter } from "./api/webhook";
import { authMiddleware } from "./auth/middleware";

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors({ origin: "*", credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/auth", createAuthRouter());

app.use("/api/contents/*", authMiddleware);
app.route("/api/contents", createContentsRouter());

app.use("/api/recommendations/*", authMiddleware);
app.route("/api/recommendations", createRecommendationsRouter());

app.route("/api/webhook", createWebhookRouter());

export default {
  fetch: app.fetch,
};
```

- [ ] **Step 7: Run all tests**

Run: `cd web && npx vitest run`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add web/worker/services/recommend.ts web/worker/api/recommendations.ts web/worker/api/webhook.ts web/tests/services/recommend.test.ts web/worker/index.ts
git commit -m "feat(web): add recommendation service and webhook handler"
```

---

### Task 8: Frontend — routing, auth context, login page

**Files:**
- Create: `web/src/lib/api.ts`
- Create: `web/src/hooks/useAuth.ts`
- Create: `web/src/pages/Login.tsx`
- Create: `web/src/pages/Verify.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Create API client**

Create `web/src/lib/api.ts`:

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

export const api = {
  auth: {
    login: (email: string) => request("/auth/login", { method: "POST", body: JSON.stringify({ email }) }),
    verify: (token: string) => request<{ user: { id: string; email: string } }>(`/auth/verify?token=${token}`),
    me: () => request<{ user: { id: string; email: string } }>("/auth/me"),
    logout: () => request("/auth/logout", { method: "POST" }),
  },
  contents: {
    list: () => request<{ items: any[] }>("/contents"),
    import: (items: any[]) => request<{ items: any[] }>("/contents/import", { method: "POST", body: JSON.stringify({ items }) }),
    update: (id: string, fields: any) => request(`/contents/${id}`, { method: "PATCH", body: JSON.stringify(fields) }),
    delete: (id: string) => request(`/contents/${id}`, { method: "DELETE" }),
  },
  recommendations: {
    get: () => request<{ recommendations: any[] }>("/recommendations"),
  },
};
```

- [ ] **Step 2: Create auth hook**

Create `web/src/hooks/useAuth.ts`:

```tsx
import { useState, useEffect, createContext, useContext } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";

interface AuthState {
  user: { id: string; email: string } | null;
  loading: boolean;
  login: (email: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<{ id: string; email: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.auth.me().then((res) => setUser(res.user)).catch(() => setUser(null)).finally(() => setLoading(false));
  }, []);

  const login = async (email: string) => {
    await api.auth.login(email);
  };

  const logout = async () => {
    await api.auth.logout();
    setUser(null);
  };

  return (
    <AuthContext value={{ user, loading, login, logout }}>
      {children}
    </AuthContext>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function setAuthUser(user: { id: string; email: string }) {
  // Used after verify — triggers re-render via AuthProvider
}
```

- [ ] **Step 3: Create Login page**

Create `web/src/pages/Login.tsx`:

```tsx
import { useState } from "react";
import { useAuth } from "../hooks/useAuth";

export function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await login(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    }
  };

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md w-full p-8 bg-white rounded-lg shadow">
          <h2 className="text-xl font-semibold mb-4">Check your email</h2>
          <p className="text-gray-600">We sent a sign-in link to <strong>{email}</strong>. Click it to log in.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <form onSubmit={handleSubmit} className="max-w-md w-full p-8 bg-white rounded-lg shadow">
        <h1 className="text-2xl font-bold mb-6">Sign in to UniSCRM</h1>
        {error && <p className="text-red-600 mb-4">{error}</p>}
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          required
          className="w-full px-4 py-2 border rounded-md mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button type="submit" className="w-full py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700">
          Send Magic Link
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Create Verify page**

Create `web/src/pages/Verify.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api } from "../lib/api";

export function Verify() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState("");

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setError("Missing token");
      return;
    }
    api.auth.verify(token)
      .then(() => navigate("/", { replace: true }))
      .catch((err) => setError(err instanceof Error ? err.message : "Verification failed"));
  }, [searchParams, navigate]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="max-w-md w-full p-8 bg-white rounded-lg shadow">
          <h2 className="text-xl font-semibold text-red-600 mb-4">Verification Failed</h2>
          <p className="text-gray-600">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <p className="text-gray-600">Verifying...</p>
    </div>
  );
}
```

- [ ] **Step 5: Update App.tsx with routing**

```tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { Login } from "./pages/Login";
import { Verify } from "./pages/Verify";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Home() {
  return <div className="p-8"><h1 className="text-2xl font-bold">Recommendations</h1><p className="text-gray-500 mt-2">Coming in next task...</p></div>;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/verify" element={<Verify />} />
          <Route path="/" element={<ProtectedRoute><Home /></ProtectedRoute>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
```

- [ ] **Step 6: Verify in browser**

Run: `cd web && npm run dev` (and `npx wrangler dev --env dev --port 8788` in parallel)

Verify:
- `/login` shows email form
- Submitting email calls `/api/auth/login`
- Unauthenticated `/` redirects to `/login`

- [ ] **Step 7: Commit**

```bash
git add web/src/
git commit -m "feat(web): add routing, auth context, login and verify pages"
```

---

### Task 9: Frontend — Content Library page with import

**Files:**
- Create: `web/src/lib/markdown.ts`
- Create: `web/src/hooks/useContents.ts`
- Create: `web/src/pages/Contents.tsx`
- Create: `web/src/components/ImportZone.tsx`
- Create: `web/src/components/ContentTable.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Create markdown parser utility**

Create `web/src/lib/markdown.ts`:

```typescript
export interface ParsedMd {
  filename: string;
  title: string;
  summary: string;
  fileModifiedAt: string | null;
}

export function parseMdFile(file: File, text: string): ParsedMd {
  const headingMatch = text.match(/^#\s+(.+)$/m);
  const heading = headingMatch?.[1]?.trim();
  const title = heading ? `${file.name} — ${heading}` : file.name;

  const bodyText = text
    .replace(/^#.*$/gm, "")
    .replace(/[*_`~\[\]()>#+-]/g, "")
    .replace(/\n+/g, " ")
    .trim();
  const summary = bodyText.slice(0, 200);

  return {
    filename: file.name,
    title,
    summary,
    fileModifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
  };
}

export async function readMdFiles(files: File[]): Promise<ParsedMd[]> {
  const mdFiles = files.filter((f) => f.name.endsWith(".md"));
  const parsed = await Promise.all(
    mdFiles.map(async (file) => {
      const text = await file.text();
      return parseMdFile(file, text);
    })
  );
  return parsed.sort((a, b) => {
    if (!a.fileModifiedAt || !b.fileModifiedAt) return 0;
    return new Date(b.fileModifiedAt).getTime() - new Date(a.fileModifiedAt).getTime();
  });
}
```

- [ ] **Step 2: Create useContents hook**

Create `web/src/hooks/useContents.ts`:

```tsx
import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";
import type { ParsedMd } from "../lib/markdown";

interface ContentItem {
  id: string;
  filename: string;
  title: string;
  summary: string | null;
  status: string;
  file_modified_at: string | null;
  created_at: string;
}

export function useContents() {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.contents.list();
      setItems(res.items);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const importFiles = async (parsed: ParsedMd[]) => {
    const mapped = parsed.map((p) => ({
      filename: p.filename,
      title: p.title,
      summary: p.summary,
      file_modified_at: p.fileModifiedAt,
    }));
    await api.contents.import(mapped);
    await refresh();
  };

  const updateItem = async (id: string, fields: { title?: string; summary?: string; status?: string }) => {
    await api.contents.update(id, fields);
    await refresh();
  };

  const deleteItem = async (id: string) => {
    await api.contents.delete(id);
    await refresh();
  };

  return { items, loading, refresh, importFiles, updateItem, deleteItem };
}
```

- [ ] **Step 3: Create ImportZone component**

Create `web/src/components/ImportZone.tsx`:

```tsx
import { useState, useRef } from "react";
import { readMdFiles, type ParsedMd } from "../lib/markdown";

interface Props {
  onImport: (files: ParsedMd[]) => Promise<void>;
}

export function ImportZone({ onImport }: Props) {
  const [previewing, setPreviewing] = useState<ParsedMd[]>([]);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: File[]) => {
    const parsed = await readMdFiles(files);
    setPreviewing(parsed);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files: File[] = [];
    for (const item of Array.from(e.dataTransfer.items)) {
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        const dirFiles = await readDirectory(entry as FileSystemDirectoryEntry);
        files.push(...dirFiles);
      } else if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    await handleFiles(files);
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    await handleFiles(files);
  };

  const handleConfirm = async () => {
    setImporting(true);
    try {
      await onImport(previewing);
      setPreviewing([]);
    } finally {
      setImporting(false);
    }
  };

  if (previewing.length > 0) {
    return (
      <div className="border rounded-lg p-4 mb-6">
        <h3 className="font-semibold mb-3">Preview ({previewing.length} files)</h3>
        <div className="max-h-60 overflow-y-auto mb-4">
          {previewing.map((f) => (
            <div key={f.filename} className="flex justify-between py-1 text-sm border-b">
              <span className="truncate">{f.title}</span>
              <span className="text-gray-400 ml-2 shrink-0">
                {f.fileModifiedAt ? new Date(f.fileModifiedAt).toLocaleDateString() : "—"}
              </span>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <button onClick={handleConfirm} disabled={importing} className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50">
            {importing ? "Importing..." : "Confirm Import"}
          </button>
          <button onClick={() => setPreviewing([])} className="px-4 py-2 border rounded-md hover:bg-gray-50">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`border-2 border-dashed rounded-lg p-8 mb-6 text-center transition-colors ${dragging ? "border-blue-500 bg-blue-50" : "border-gray-300"}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <p className="text-gray-500 mb-3">Drag & drop .md files or a folder here</p>
      <input ref={inputRef} type="file" className="hidden" onChange={handleFolderSelect} {...{ webkitdirectory: "", directory: "" } as any} />
      <button onClick={() => inputRef.current?.click()} className="px-4 py-2 bg-white border rounded-md hover:bg-gray-50">
        Select Folder
      </button>
    </div>
  );
}

async function readDirectory(entry: FileSystemDirectoryEntry): Promise<File[]> {
  const reader = entry.createReader();
  return new Promise((resolve) => {
    const files: File[] = [];
    reader.readEntries(async (entries) => {
      for (const e of entries) {
        if (e.isFile) {
          const file = await new Promise<File>((res) => (e as FileSystemFileEntry).file(res));
          files.push(file);
        }
      }
      resolve(files);
    });
  });
}
```

- [ ] **Step 4: Create ContentTable component**

Create `web/src/components/ContentTable.tsx`:

```tsx
import { useState } from "react";

interface ContentItem {
  id: string;
  filename: string;
  title: string;
  summary: string | null;
  status: string;
  file_modified_at: string | null;
}

interface Props {
  items: ContentItem[];
  onUpdate: (id: string, fields: { title?: string; summary?: string; status?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

const STATUS_OPTIONS = ["new", "pending", "published", "ignored"] as const;

export function ContentTable({ items, onUpdate, onDelete }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSummary, setEditSummary] = useState("");

  const startEdit = (item: ContentItem) => {
    setEditingId(item.id);
    setEditTitle(item.title);
    setEditSummary(item.summary ?? "");
  };

  const saveEdit = async (id: string) => {
    await onUpdate(id, { title: editTitle, summary: editSummary });
    setEditingId(null);
  };

  if (items.length === 0) {
    return <p className="text-gray-500 text-center py-8">No content yet. Import .md files above.</p>;
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left">
          <th className="py-2 font-medium">Title</th>
          <th className="py-2 font-medium w-28">Status</th>
          <th className="py-2 font-medium w-28">Modified</th>
          <th className="py-2 font-medium w-20">Actions</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id} className="border-b hover:bg-gray-50">
            <td className="py-2">
              {editingId === item.id ? (
                <div className="space-y-1">
                  <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="w-full px-2 py-1 border rounded text-sm" />
                  <textarea value={editSummary} onChange={(e) => setEditSummary(e.target.value)} rows={2} className="w-full px-2 py-1 border rounded text-sm" />
                  <div className="flex gap-1">
                    <button onClick={() => saveEdit(item.id)} className="text-blue-600 text-xs">Save</button>
                    <button onClick={() => setEditingId(null)} className="text-gray-400 text-xs">Cancel</button>
                  </div>
                </div>
              ) : (
                <div onClick={() => startEdit(item)} className="cursor-pointer">
                  <div className="font-medium">{item.title}</div>
                  {item.summary && <div className="text-gray-400 truncate max-w-md">{item.summary}</div>}
                </div>
              )}
            </td>
            <td className="py-2">
              <select
                value={item.status}
                onChange={(e) => onUpdate(item.id, { status: e.target.value })}
                className="text-xs border rounded px-2 py-1"
              >
                {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </td>
            <td className="py-2 text-gray-400">
              {item.file_modified_at ? new Date(item.file_modified_at).toLocaleDateString() : "—"}
            </td>
            <td className="py-2">
              <button onClick={() => onDelete(item.id)} className="text-red-500 text-xs hover:underline">
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

- [ ] **Step 5: Create Contents page and wire routing**

Create `web/src/pages/Contents.tsx`:

```tsx
import { useContents } from "../hooks/useContents";
import { ImportZone } from "../components/ImportZone";
import { ContentTable } from "../components/ContentTable";

export function Contents() {
  const { items, loading, importFiles, updateItem, deleteItem } = useContents();

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-6">Content Library</h1>
      <ImportZone onImport={importFiles} />
      {loading ? (
        <p className="text-gray-500 text-center py-8">Loading...</p>
      ) : (
        <ContentTable items={items} onUpdate={updateItem} onDelete={deleteItem} />
      )}
    </div>
  );
}
```

Update `web/src/App.tsx` — add the `/contents` route and a nav bar:

```tsx
import { BrowserRouter, Routes, Route, Navigate, Link } from "react-router-dom";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { Login } from "./pages/Login";
import { Verify } from "./pages/Verify";
import { Contents } from "./pages/Contents";

function Nav() {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <nav className="bg-white border-b px-8 py-3 flex items-center justify-between">
      <div className="flex gap-6">
        <Link to="/" className="font-semibold">Recommendations</Link>
        <Link to="/contents" className="text-gray-600 hover:text-black">Content Library</Link>
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-500">{user.email}</span>
        <button onClick={logout} className="text-sm text-gray-400 hover:text-black">Logout</button>
      </div>
    </nav>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function Home() {
  return <div className="max-w-4xl mx-auto p-8"><h1 className="text-2xl font-bold">Recommendations</h1><p className="text-gray-500 mt-2">Coming in next task...</p></div>;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Nav />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/verify" element={<Verify />} />
          <Route path="/" element={<ProtectedRoute><Home /></ProtectedRoute>} />
          <Route path="/contents" element={<ProtectedRoute><Contents /></ProtectedRoute>} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
```

- [ ] **Step 6: Test in browser**

Run dev servers and verify:
- `/contents` shows import zone + empty table
- Drag .md files → preview list appears sorted by date → confirm → table populates
- Click title → inline edit → save
- Status dropdown changes status
- Delete removes row

- [ ] **Step 7: Commit**

```bash
git add web/src/
git commit -m "feat(web): add Content Library page with import, edit, status marking"
```

---

### Task 10: Frontend — Recommendations page

**Files:**
- Create: `web/src/hooks/useRecommendations.ts`
- Create: `web/src/pages/Home.tsx`
- Modify: `web/src/App.tsx`

- [ ] **Step 1: Create useRecommendations hook**

Create `web/src/hooks/useRecommendations.ts`:

```tsx
import { useState, useEffect, useCallback } from "react";
import { api } from "../lib/api";

interface TrendMatch {
  trend_id: string;
  title: string;
  platform: string;
  location: string;
  similarity: number;
}

interface Recommendation {
  content_id: string;
  title: string;
  matches: TrendMatch[];
}

export function useRecommendations() {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.recommendations.get();
      setRecommendations(res.recommendations);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { recommendations, loading, refresh };
}
```

- [ ] **Step 2: Create Home page with recommendation cards**

Create `web/src/pages/Home.tsx`:

```tsx
import { useState } from "react";
import { useRecommendations } from "../hooks/useRecommendations";
import { api } from "../lib/api";

const STATUS_OPTIONS = ["new", "pending", "published", "ignored"] as const;

export function Home() {
  const { recommendations, loading } = useRecommendations();
  const [expanded, setExpanded] = useState<string | null>(null);

  if (loading) {
    return <div className="max-w-4xl mx-auto p-8"><p className="text-gray-500">Loading recommendations...</p></div>;
  }

  if (recommendations.length === 0) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <h1 className="text-2xl font-bold mb-4">Recommendations</h1>
        <p className="text-gray-500">No recommendations yet. Import content and wait for trend matching.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-6">Top Recommendations</h1>
      <div className="space-y-4">
        {recommendations.map((rec) => {
          const bestScore = Math.max(...rec.matches.map((m) => m.similarity));
          const isExpanded = expanded === rec.content_id;
          return (
            <div key={rec.content_id} className="bg-white rounded-lg border p-4">
              <div
                className="flex items-center justify-between cursor-pointer"
                onClick={() => setExpanded(isExpanded ? null : rec.content_id)}
              >
                <div>
                  <h3 className="font-semibold">{rec.title}</h3>
                  <span className="text-sm text-gray-500">{rec.matches.length} matching trends</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-mono bg-blue-50 text-blue-700 px-2 py-1 rounded">
                    {(bestScore * 100).toFixed(0)}% match
                  </span>
                  <StatusDropdown contentId={rec.content_id} />
                </div>
              </div>
              {isExpanded && (
                <div className="mt-3 pt-3 border-t">
                  {rec.matches.map((m) => (
                    <div key={m.trend_id} className="flex justify-between py-1 text-sm">
                      <span>{m.title}</span>
                      <span className="text-gray-400">{m.platform} · {(m.similarity * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusDropdown({ contentId }: { contentId: string }) {
  const [status, setStatus] = useState("new");

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newStatus = e.target.value;
    setStatus(newStatus);
    await api.contents.update(contentId, { status: newStatus });
  };

  return (
    <select value={status} onChange={handleChange} onClick={(e) => e.stopPropagation()} className="text-xs border rounded px-2 py-1">
      {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );
}
```

- [ ] **Step 3: Wire Home page into App.tsx**

In `web/src/App.tsx`, replace the placeholder `Home` function import:

```tsx
import { Home } from "./pages/Home";
```

And remove the inline `Home` function component. The route `<Route path="/" ...>` already references `<Home />`.

- [ ] **Step 4: Test in browser**

Verify:
- `/` shows "No recommendations yet" when empty
- After importing content and having trends in Vectorize, shows top 5 cards
- Click card to expand trend matches
- Status dropdown works
- Match percentage displayed correctly

- [ ] **Step 5: Commit**

```bash
git add web/src/
git commit -m "feat(web): add Recommendations page with trend matching display"
```

---

### Task 11: End-to-end verification

**Files:** None (testing only)

- [ ] **Step 1: Start both services**

Terminal 1: `cd trend-skill && npx wrangler dev --env dev`
Terminal 2: `cd web && npx wrangler dev --env dev --port 8788`
Terminal 3: `cd web && npm run dev`

- [ ] **Step 2: Trigger trend fetch to populate Vectorize**

```bash
curl -X POST http://localhost:8787/admin/trigger-fetch -H "Authorization: Bearer $ADMIN_SECRET"
```

Expected: `{"status":"ok","message":"Fetch pipeline completed"}`

- [ ] **Step 3: Test Magic Link flow**

1. Open `http://localhost:5173/login`
2. Enter email, submit
3. Check Resend dashboard (or use a test email) for magic link
4. Visit the verify URL → should redirect to `/`

- [ ] **Step 4: Import content**

1. Navigate to `/contents`
2. Drag a folder of .md files or use "Select Folder"
3. Verify preview shows files sorted by date
4. Click "Confirm Import"
5. Verify content appears in table

- [ ] **Step 5: Check recommendations**

1. Navigate to `/`
2. Verify top 5 content items appear with trend matches
3. Expand a card to see matched trends with similarity %
4. Change status on a recommendation

- [ ] **Step 6: Test webhook re-matching**

```bash
curl -X POST http://localhost:8788/api/webhook/trend-update \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Signature: $(echo -n '{"event":"trend.daily_digest"}' | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | cut -d' ' -f2)" \
  -d '{"event":"trend.daily_digest"}'
```

Expected: `{"ok":true,"users_updated":1}`

- [ ] **Step 7: Run all tests**

```bash
cd trend-skill && npx vitest run
cd web && npx vitest run
```

Expected: All tests PASS in both projects

- [ ] **Step 8: Commit any final fixes**

If any adjustments were needed during verification, commit them.
