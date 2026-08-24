import { describe, it, expect } from "vitest";
import { ContentMetadata_GitHub } from "../../../metadata/github";
import { PROPS } from "../../../metadata/props";

const META = ContentMetadata_GitHub.find((m) => m.sourceContentType === "watch:get-releases")!;

describe("ContentMetadata_GitHub", () => {
  it("是 trigger，不落库", () => {
    // flowType 决定 upsertContentFromMetadata 会不会拒收；写死在测试里防止有人手滑改成 "content"
    expect(META.flowType).toBe("trigger");
  });

  it("content props 映射到 /releases 的真实字段", () => {
    const byId = Object.fromEntries(META.contentProps.map((p) => [p.propId, p]));
    expect(byId.content_type.value).toBe("RELEASE");
    expect(byId.source_content_id.dataId).toBe("id");
    expect(byId.source_created_at.dataId).toBe("published_at");
    expect(byId.title.dataId).toBe("name");
    expect(byId.content_text.dataId).toBe("body");
    expect(byId.content_url.dataId).toBe("html_url");
    expect(byId.tag_name.dataId).toBe("tag_name");
    expect(byId.is_prerelease.dataId).toBe("prerelease");
  });

  it("三个计数只声明、不给 dataId/value —— 值由 flow 侧注入", () => {
    // resolveProps 会跳过既无 value 也无 dataId 的条目；声明的唯一目的是让条件编辑器
    // 的字段列表带上它们（同 metadata/youtube.ts 的 duration）
    for (const id of ["release_count_1d", "release_count_7d", "release_count_30d"]) {
      const m = META.contentProps.find((p) => p.propId === id)!;
      expect(m).toBeDefined();
      expect(m.dataId).toBeUndefined();
      expect(m.value).toBeUndefined();
    }
  });

  it("release_notes_1d 同样只声明、不给 dataId/value —— 值由 flow 侧注入的 JSON 字符串", () => {
    const m = META.contentProps.find((p) => p.propId === "release_notes_1d")!;
    expect(m).toBeDefined();
    expect(m.dataId).toBeUndefined();
    expect(m.value).toBeUndefined();
  });

  it("作者字段是 repo，star 复用 followers_count", () => {
    const byId = Object.fromEntries((META.userProps ?? []).map((p) => [p.propId, p]));
    expect(byId.source_user_id.dataId).toBe("id");
    expect(byId.name.dataId).toBe("full_name");
    expect(byId.username.dataId).toBe("name");
    expect(byId.description.dataId).toBe("description");
    expect(byId.profile_image_url.dataId).toBe("owner.avatar_url");
    expect(byId.followers_count.dataId).toBe("stargazers_count");
  });

  it("新增的 prop 都不带 entity —— 它们只活在 flow payload 里", () => {
    // entity 的契约是「表上的真实列」，标了不建列会被 stream-schema 对账测试判红
    for (const id of ["tag_name", "is_prerelease", "release_count_1d", "release_count_7d", "release_count_30d", "release_notes_1d"]) {
      const def = PROPS.find((p) => p.propId === id);
      expect(def, `prop ${id} 未注册`).toBeDefined();
      expect(def!.entity, `prop ${id} 不该带 entity`).toBeUndefined();
    }
  });

  it("content_type 枚举含 RELEASE", () => {
    const ct = PROPS.find((p) => p.propId === "content_type")!;
    expect(ct.enums!.some((e) => e.value === "RELEASE")).toBe(true);
  });
});
