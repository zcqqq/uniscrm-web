import { TenantDataDB } from "../../../shared/tenant-data-db";
import { PROPS_X } from "../../../metadata/x";
import type { Pipeline } from "../types";

const INSIGHT_PROPS = PROPS_X.filter((p) => p.isInsight);

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
  private pipelineEvent?: Pipeline;
  private pipelineUser?: Pipeline;
  private tenantId?: number;

  constructor(private tenantDb: TenantDataDB, opts?: { queue?: Queue; pipelineEvent?: Pipeline; pipelineUser?: Pipeline; tenantId?: number }) {
    this.queue = opts?.queue;
    this.pipelineEvent = opts?.pipelineEvent;
    this.pipelineUser = opts?.pipelineUser;
    this.tenantId = opts?.tenantId;
  }

  async upsertUser(user: XUserData, channelId: string, channelType: string): Promise<void> {
    console.log(JSON.stringify({ event: "x_user_raw", user_id: user.id, payload: user }));
    const dbData = JSON.stringify(pickDbFields(user));
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await this.tenantDb.run(
      `INSERT INTO user (id, channel_id, source_user_id, channel_type, name, username, profile_image_url, raw_data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(channel_id, source_user_id) DO UPDATE SET
         name = CASE WHEN excluded.name IS NOT NULL AND excluded.name != '' THEN excluded.name ELSE user.name END,
         username = CASE WHEN excluded.username IS NOT NULL AND excluded.username != '' THEN excluded.username ELSE user.username END,
         profile_image_url = CASE WHEN excluded.profile_image_url IS NOT NULL AND excluded.profile_image_url != '' THEN excluded.profile_image_url ELSE user.profile_image_url END,
         raw_data = json_patch(user.raw_data, excluded.raw_data),
         updated_at = datetime('now')`,
      [id, channelId, user.id, channelType, user.name || null, user.username || null, user.profile_image_url || null, dbData]
    );

    if (this.pipelineUser && this.tenantId) {
      const record: Record<string, unknown> = {
        tenant_id: this.tenantId,
        id: id,
        channel_id: channelId,
        source_user_id: user.id,
        channel_type: channelType,
        name: user.name || null,
        username: user.username || null,
        is_active: 1,
        is_follow: 0,
        is_followed: 0,
        created_at: now,
        updated_at: now,
      };
      for (const prop of INSIGHT_PROPS) {
        const pm = (user as Record<string, unknown>).public_metrics as Record<string, unknown> | undefined;
        const val = prop.propId.includes("_count")
          ? pm?.[prop.propId]
          : (user as Record<string, unknown>)[prop.propId];
        if (val !== undefined && val !== null) {
          record[prop.propId] = val;
        }
      }
      await this.pipelineUser.send([record]).catch((err) => {
        console.error(JSON.stringify({ event: "pipeline_user_error", error: String(err) }));
      });
    }
  }

  async upsertUserFromMetadata(
    rawItem: Record<string, unknown>,
    resolvedProps: Record<string, unknown>,
    channelId: string,
    channelType: string
  ): Promise<boolean> {
    const sourceUserId = String(resolvedProps.source_user_id ?? rawItem.id ?? "");
    if (!sourceUserId) throw new Error("upsertUserFromMetadata: missing source_user_id");

    const existing = await this.tenantDb.query<{ id: string }>(
      "SELECT id FROM user WHERE channel_id = ? AND source_user_id = ?",
      [channelId, sourceUserId]
    );
    const isNew = existing.length === 0;
    const id = isNew ? crypto.randomUUID() : existing[0].id;
    const now = new Date().toISOString();
    const rawData = JSON.stringify(rawItem);
    const name = resolvedProps.name != null ? String(resolvedProps.name) : null;
    const username = resolvedProps.username != null ? String(resolvedProps.username) : null;
    const profileImageUrl = resolvedProps.profile_image_url != null ? String(resolvedProps.profile_image_url) : null;
    const isFollowed = resolvedProps.is_followed !== undefined ? resolvedProps.is_followed : 0;

    // Atomic upsert: INSERT ... ON CONFLICT DO UPDATE closes the TOCTOU race where two
    // concurrent writers (e.g. a backfill poll and a real-time webhook event) both see
    // "not found" and both attempt INSERT, colliding on idx_user_channel_source.
    const updateSets: string[] = ["raw_data = json_patch(user.raw_data, excluded.raw_data)", "updated_at = datetime('now')"];
    if (name) updateSets.push("name = excluded.name");
    if (username) updateSets.push("username = excluded.username");
    if (profileImageUrl) updateSets.push("profile_image_url = excluded.profile_image_url");
    if (resolvedProps.is_followed !== undefined) updateSets.push("is_followed = excluded.is_followed");

    await this.tenantDb.run(
      `INSERT INTO user (id, channel_id, source_user_id, channel_type, name, username, profile_image_url, raw_data, is_followed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(channel_id, source_user_id) DO UPDATE SET
         ${updateSets.join(",\n         ")}`,
      [id, channelId, sourceUserId, channelType, name, username, profileImageUrl, rawData, isFollowed]
    );

    if (this.pipelineUser && this.tenantId) {
      const record: Record<string, unknown> = {
        tenant_id: this.tenantId,
        id,
        channel_id: channelId,
        source_user_id: sourceUserId,
        channel_type: channelType,
        created_at: now,
        updated_at: now,
      };
      // Only isInsight-marked props are dynamic columns on the R2 pipeline's user
      // table (docs/superpowers/specs/2026-06-26-r2-data-catalog-migration-design.md) —
      // free-text fields like description stay D1-only (raw_data), never reach R2.
      for (const prop of INSIGHT_PROPS) {
        if (prop.propId in resolvedProps) record[prop.propId] = resolvedProps[prop.propId];
      }
      await this.pipelineUser.send([record]).catch((err) => {
        console.error(JSON.stringify({ event: "pipeline_user_error", error: String(err) }));
      });
    }

    return isNew;
  }

  async setUserActive(userId: string, active: boolean): Promise<void> {
    await this.tenantDb.run(
      "UPDATE user SET is_active = ?, updated_at = datetime('now') WHERE id = ?",
      [active ? 1 : 0, userId]
    );
  }

  async setFollowState(sourceUserId: string, channelId: string, field: "is_follow" | "is_followed", value: 0 | 1): Promise<void> {
    await this.tenantDb.run(
      `UPDATE user SET ${field} = ?, updated_at = datetime('now') WHERE channel_id = ? AND source_user_id = ?`,
      [value, channelId, sourceUserId]
    );
  }

  async upsertUsers(users: XUserData[]): Promise<void> {
    let newUserIds = new Set<string>();
    if (this.queue && users.length > 0) {
      const ids = users.map((u) => u.id);
      const placeholders = ids.map(() => "?").join(",");
      const existing = await this.tenantDb.query<{ id: string }>(
        `SELECT id FROM user WHERE id IN (${placeholders})`,
        ids
      );
      const existingIds = new Set(existing.map((r) => r.id));
      newUserIds = new Set(ids.filter((id) => !existingIds.has(id)));
    }

    if (users.length > 0) {
      console.log(JSON.stringify({ event: "x_user_raw", sample: true, user_id: users[0].id, payload: users[0] }));
    }

    const statements = users.map((user) => {
      const dbData = JSON.stringify(pickDbFields(user));
      return {
        sql: `INSERT INTO user (id, name, username, profile_image_url, raw_data, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
              ON CONFLICT(id) DO UPDATE SET
                name = CASE WHEN excluded.name IS NOT NULL AND excluded.name != '' THEN excluded.name ELSE user.name END,
                username = CASE WHEN excluded.username IS NOT NULL AND excluded.username != '' THEN excluded.username ELSE user.username END,
                profile_image_url = CASE WHEN excluded.profile_image_url IS NOT NULL AND excluded.profile_image_url != '' THEN excluded.profile_image_url ELSE user.profile_image_url END,
                raw_data = json_patch(user.raw_data, excluded.raw_data),
                updated_at = datetime('now')`,
        params: [user.id, user.name || null, user.username || null, user.profile_image_url || null, dbData],
      };
    });
    await this.tenantDb.batch(statements);

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
    const now = new Date().toISOString();
    const ids = events.map(() => crypto.randomUUID());
    const statements = events.map((e, i) => ({
      sql: `INSERT INTO event (id, user_id, channel_id, event_type, event_time, raw_data, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [ids[i], e.userId, e.channelId, e.eventType, e.eventTime || null, JSON.stringify(e.rawData || {}), now],
    }));
    await this.tenantDb.batch(statements);

    if (this.pipelineEvent && this.tenantId) {
      const records = events.map((e, i) => {
        const record: Record<string, unknown> = {
          tenant_id: this.tenantId!,
          id: ids[i],
          user_id: e.userId,
          channel_id: e.channelId,
          event_type: e.eventType,
          event_time: e.eventTime || now,
          created_at: now,
        };
        const raw = (e.rawData || {}) as Record<string, unknown>;
        for (const prop of INSIGHT_PROPS) {
          if (prop.propId in raw) record[prop.propId] = raw[prop.propId];
        }
        return record;
      });
      await this.pipelineEvent.send(records).catch((err) => {
        console.error(JSON.stringify({ event: "pipeline_event_error", error: String(err) }));
      });
    }
  }
}
