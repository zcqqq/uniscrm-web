import { describe, it, expect } from "vitest";
import { computeInsertPrefix, computeSelectedDisplay } from "../../../shared/frontend/components/SelectPropsValue";

// Deviation from the original brief's test approach: it called for rendering SelectPropsValue
// with @testing-library/react and clicking an option. That package isn't installed anywhere in
// this repo (checked root, flow, web, shared), and this module's test runner is
// @cloudflare/vitest-pool-workers (workerd) — there's no `document` global for react-dom to
// mount into regardless, and no react-test-renderer (DOM-free alternative) installed either.
// Installing either would touch flow/package.json + package-lock.json, outside this task's
// approved 4-file commit, and could leave an uncommitted lockfile change in a repo other
// sessions are concurrently committing to. So the $-prefix decision was pulled out of
// handleSelect into the pure, exported `computeInsertPrefix` (see SelectPropsValue.tsx) and is
// tested directly here — same behavior guarantee, no DOM needed.
describe("SelectPropsValue insert 变体的 $ 前缀", () => {
  it("已限定的 id 只加 $，不重复拼分组前缀", () => {
    // 拼成 $user.user.followers_count 的话 engine 的 PROP_REF_RE 会匹配出
    // "user.user.followers_count"，payload 里没有这个键 → 条件静默恒不通过。
    const opt = { id: "user.followers_count", label: "Followers", group: "user" as const };
    expect(computeInsertPrefix(opt) + opt.id).toBe("$user.followers_count");
  });

  it("未限定的 user 分组 id 仍补装饰性前缀（user flow）", () => {
    const opt = { id: "followers_count", label: "Followers", group: "user" as const };
    expect(computeInsertPrefix(opt) + opt.id).toBe("$user.followers_count");
  });

  it("content 分组的裸 id 只加 $", () => {
    const opt = { id: "like_count", label: "Likes", group: "content" as const };
    expect(computeInsertPrefix(opt) + opt.id).toBe("$like_count");
  });
});

// 同上，纯函数直接断言，不引 @testing-library/react（本仓库没装，workerd 里也没有 document）。
describe("SelectPropsValue 收起态的分组标注", () => {
  it("同名的作者字段与内容字段收起后必须能分辨", () => {
    // 这两条条件的含义完全不同：这条推文被点了多少赞 vs 作者一共点过多少赞。
    const authorLikes = { id: "user.like_count", label: "Likes", group: "user" as const };
    const contentLikes = { id: "like_count", label: "Likes", group: "content" as const };
    expect(computeSelectedDisplay(authorLikes)).not.toBe(computeSelectedDisplay(contentLikes));
  });

  it("限定名带上分组名", () => {
    expect(computeSelectedDisplay({ id: "user.followers_count", label: "Followers", group: "user" as const }))
      .toBe("User · Followers");
  });

  it("裸 id 不变（存量 user flow 的观感不动）", () => {
    expect(computeSelectedDisplay({ id: "followers_count", label: "Followers", group: "user" as const }))
      .toBe("Followers");
    expect(computeSelectedDisplay({ id: "like_count", label: "Likes", group: "content" as const }))
      .toBe("Likes");
    expect(computeSelectedDisplay({ id: "event_time", label: "Event Time", group: "event" as const }))
      .toBe("Event Time");
  });
});
