import { describe, it, expect, vi } from "vitest";
import { resolveUserPropsForFilter } from "../../src/index";

describe("resolveUserPropsForFilter", () => {
  // C1 regression guard: entity_state's business key is (tenant_id, entity, channel_id,
  // secondary_id, source_id) — see link/src/services/entity-state.ts's claim()/get(). flow's
  // `userId` is the EXTERNAL platform id (X's numeric user id), never entity_state's minted
  // `entity_id` uuid, so the query must bind userId as source_id (with entity='user',
  // secondary_id='') and never as entity_id. A prior version queried
  // `WHERE tenant_id = ? AND entity_id = ?` with userId bound as entity_id — that query never
  // matches a real row (see the mutation-test note in this file's companion report), silently
  // skipping every userPropsFilter-gated action.
  it("binds channelId/userId as (entity='user', channel_id, secondary_id='', source_id) — EntityStateStore's own key shape", async () => {
    const first = vi.fn().mockResolvedValue({ is_follow: 1, is_followed: 0 });
    const bind = vi.fn().mockReturnValue({ first });
    const prepare = vi.fn().mockReturnValue({ bind });
    const env = { LINK_DB: { prepare } };

    const props = await resolveUserPropsForFilter(env as any, 7, "chan1", "x-user-42");

    expect(props).toEqual({ is_follow: 1, is_followed: 0 });

    // Assert the actual SQL text keys on entity/channel_id/secondary_id/source_id, not entity_id.
    const sql = prepare.mock.calls[0][0] as string;
    expect(sql).toContain("entity = 'user'");
    expect(sql).toContain("channel_id = ?");
    expect(sql).toContain("secondary_id = ''");
    expect(sql).toContain("source_id = ?");
    expect(sql).not.toMatch(/entity_id\s*=\s*\?/);

    // Assert the bound parameter order/values: tenantId, channelId, userId.
    expect(bind).toHaveBeenCalledWith(7, "chan1", "x-user-42");
  });

  // Proves the fix actually reaches the row a poller/webhook wrote via EntityStateStore.claim()
  // under (channel_id, source_id) — i.e. an X-id lookup succeeds against real entity_state key
  // shape, not just against a mock that echoes back whatever was asked.
  it("finds the row a poller wrote under (channel_id, source_id) when queried by the X user id", async () => {
    // Minimal in-memory stand-in for entity_state, keyed exactly like the real table.
    const store = new Map<string, { is_follow: number | null; is_followed: number | null }>();
    const key = (tenantId: number, channelId: string, sourceId: string) => `${tenantId}|user|${channelId}||${sourceId}`;
    // Simulate a poller having claimed this X user and set is_follow=1 via EntityStateStore.
    store.set(key(7, "chan1", "x-user-42"), { is_follow: 1, is_followed: 0 });

    const env = {
      LINK_DB: {
        prepare: () => ({
          bind: (tenantId: number, channelId: string, sourceId: string) => ({
            first: async () => store.get(key(tenantId, channelId, sourceId)) ?? null,
          }),
        }),
      },
    };

    const props = await resolveUserPropsForFilter(env as any, 7, "chan1", "x-user-42");
    expect(props).toEqual({ is_follow: 1, is_followed: 0 });
  });

  it("returns an empty object when the user is unknown, so a fail-closed filter blocks the action", async () => {
    const env = {
      LINK_DB: { prepare: vi.fn().mockReturnValue({ bind: vi.fn().mockReturnValue({ first: vi.fn().mockResolvedValue(null) }) }) },
    };

    expect(await resolveUserPropsForFilter(env as any, 7, "chan1", "nope")).toEqual({});
  });
});
