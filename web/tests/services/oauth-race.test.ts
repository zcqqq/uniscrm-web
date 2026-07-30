import { describe, it, expect, vi } from "vitest";
import { OAuthService } from "../../worker/services/oauth";

// members.email 上的唯一索引把「先按邮箱 SELECT 查无此人，再 INSERT」的窗口给收窄了：并发用同一
// 个邮箱注册（两个 OAuth 提供方，或一个 OAuth 一个 magic link）时，慢的那个请求会撞上唯一约束。
// 跟 auth.ts 里 magic-link /verify 的既有防护（见 tests/api/magic-link-race.test.ts）一样，
// resolveUser 应该重新读到先赢的那一行继续走完登录，而不是把异常丢给调用方。
describe("OAuthService.resolveUser 撞上唯一约束时", () => {
  it("重新读到先赢的那一行，报 isNew: false，并把 oauth_accounts 挂在赢家的 member/tenant 上", async () => {
    let membersByEmailSelects = 0;
    const statements: { sql: string; args: any[] }[] = [];

    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn((...args: any[]) => {
          statements.push({ sql, args });
          return {
            first: vi.fn(async () => {
              if (sql.startsWith("SELECT member_id FROM oauth_accounts")) return null;
              if (sql.startsWith("SELECT id, tenant_id FROM members WHERE email")) {
                membersByEmailSelects++;
                // 第一次查（INSERT 之前）没有；INSERT 撞车后再查，先赢的那行已经在了——它的
                // tenant_id（42）来自赢家自己那次请求建的 tenant，不是下面这次请求刚建出来的
                // 孤儿 tenant（99）。
                return membersByEmailSelects === 1 ? null : { id: "member-winner", tenant_id: 42 };
              }
              // 这次请求自己新建的 tenant——INSERT 已落库，返回的是这个孤儿 tenant 的 id
              if (sql.startsWith("SELECT tenant_id FROM tenants WHERE email")) return { tenant_id: 99 };
              return null;
            }),
            run: vi.fn(async () => {
              if (sql.startsWith("INSERT INTO members")) {
                throw new Error("UNIQUE constraint failed: members.email");
              }
              return {};
            }),
          };
        }),
      })),
    };

    const service = new OAuthService(db as any, {} as any);
    const result = await service.resolveUser("google", "g-race", "race@example.com");

    expect(membersByEmailSelects).toBe(2);
    expect(result).toEqual({ memberId: "member-winner", tenantId: 42, isNew: false });

    // 输的一方新建的 tenant（99）成了孤儿——不该有任何东西挂在它身上
    const oauthInsert = statements.find((s) => s.sql.startsWith("INSERT INTO oauth_accounts"));
    expect(oauthInsert).toBeDefined();
    expect(oauthInsert!.args).toEqual(["google", "g-race", "member-winner", 42, expect.any(String)]);
  });

  it("再读也查无此人时，把原始的唯一约束异常继续抛出去", async () => {
    const db = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => {
            if (sql.startsWith("SELECT member_id FROM oauth_accounts")) return null;
            if (sql.startsWith("SELECT id, tenant_id FROM members WHERE email")) return null;
            if (sql.startsWith("SELECT tenant_id FROM tenants WHERE email")) return { tenant_id: 99 };
            return null;
          }),
          run: vi.fn(async () => {
            if (sql.startsWith("INSERT INTO members")) {
              throw new Error("UNIQUE constraint failed: members.email");
            }
            return {};
          }),
        })),
      })),
    };

    const service = new OAuthService(db as any, {} as any);
    await expect(service.resolveUser("google", "g-genuine", "genuine@example.com")).rejects.toThrow(
      "UNIQUE constraint failed"
    );
  });
});
