export interface XUserData {
  id: string;
  name?: string;
  username?: string;
  profile_image_url?: string;
  description?: string;
  location?: string;
  url?: string;
  verified?: boolean;
  verified_type?: string;
  protected?: boolean;
  created_at?: string;
  public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number };
  [key: string]: unknown;
}

const DB_FIELDS = ["id", "name", "username", "profile_image_url", "description", "location", "url", "verified", "verified_type", "protected", "created_at", "public_metrics"] as const;

function pickDbFields(user: XUserData): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of DB_FIELDS) {
    const val = user[key];
    if (val !== null && val !== undefined && val !== "") {
      result[key] = val;
    }
  }
  return result;
}

export class XUsersService {
  private queue?: Queue;

  constructor(private db: D1Database, queue?: Queue) {
    this.queue = queue;
  }

  async upsertUser(user: XUserData): Promise<void> {
    console.log(JSON.stringify({ event: "x_user_raw", user_id: user.id, payload: user }));
    const dbData = JSON.stringify(pickDbFields(user));
    await this.db
      .prepare(
        `INSERT INTO user_x (id, name, username, profile_image_url, raw_data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name = CASE WHEN excluded.name IS NOT NULL AND excluded.name != '' THEN excluded.name ELSE user_x.name END,
           username = CASE WHEN excluded.username IS NOT NULL AND excluded.username != '' THEN excluded.username ELSE user_x.username END,
           profile_image_url = CASE WHEN excluded.profile_image_url IS NOT NULL AND excluded.profile_image_url != '' THEN excluded.profile_image_url ELSE user_x.profile_image_url END,
           raw_data = json_patch(user_x.raw_data, excluded.raw_data),
           updated_at = datetime('now')`
      )
      .bind(user.id, user.name || null, user.username || null, user.profile_image_url || null, dbData)
      .run();
  }

  async upsertUsers(users: XUserData[]): Promise<void> {
    // Find which users are new (for maigret queue)
    let newUserIds = new Set<string>();
    if (this.queue && users.length > 0) {
      const ids = users.map((u) => u.id);
      const placeholders = ids.map(() => "?").join(",");
      const existing = await this.db
        .prepare(`SELECT id FROM user_x WHERE id IN (${placeholders})`)
        .bind(...ids)
        .all<{ id: string }>();
      const existingIds = new Set(existing.results.map((r) => r.id));
      newUserIds = new Set(ids.filter((id) => !existingIds.has(id)));
    }

    if (users.length > 0) {
      console.log(JSON.stringify({ event: "x_user_raw", sample: true, user_id: users[0].id, payload: users[0] }));
    }
    const batch = users.map((user) => {
      const dbData = JSON.stringify(pickDbFields(user));
      return this.db
        .prepare(
          `INSERT INTO user_x (id, name, username, profile_image_url, raw_data, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             name = CASE WHEN excluded.name IS NOT NULL AND excluded.name != '' THEN excluded.name ELSE user_x.name END,
             username = CASE WHEN excluded.username IS NOT NULL AND excluded.username != '' THEN excluded.username ELSE user_x.username END,
             profile_image_url = CASE WHEN excluded.profile_image_url IS NOT NULL AND excluded.profile_image_url != '' THEN excluded.profile_image_url ELSE user_x.profile_image_url END,
             raw_data = json_patch(user_x.raw_data, excluded.raw_data),
             updated_at = datetime('now')`
        )
        .bind(user.id, user.name || null, user.username || null, user.profile_image_url || null, dbData);
    });
    await this.db.batch(batch);

    // Queue maigret jobs for new users
    if (this.queue && newUserIds.size > 0) {
      const messages = users
        .filter((u) => newUserIds.has(u.id) && u.username)
        .map((u) => ({ body: { user_id: u.id, username: u.username } }));
      if (messages.length > 0) {
        await this.queue.sendBatch(messages);
      }
    }
  }

  async insertEvents(
    events: Array<{ userId: string; channelId: string; eventType: string; eventTime?: string; rawData?: unknown }>
  ): Promise<void> {
    const batch = events.map((e) =>
      this.db
        .prepare(
          `INSERT INTO event_x (id, user_id, channel_id, event_type, event_time, raw_data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .bind(
          crypto.randomUUID(),
          e.userId,
          e.channelId,
          e.eventType,
          e.eventTime || null,
          JSON.stringify(e.rawData || {}),
        )
    );
    await this.db.batch(batch);
  }

}
