import { describe, it, expect } from "vitest";
import inspectorSource from "../../frontend/components/Inspector.tsx?raw";
import accountFieldSource from "../../../shared/frontend/components/ChannelAccountField.tsx?raw";

// 这些 Inspector 是未导出的、用 hook 的组件，在 workerd 里没有 document 也没有
// testing-library 可以渲染（见 channel-node-panel-order.test.tsx 的说明）。hook 本身的
// 行为由 refreshable-list.test.ts 真跑，这里只守"每个外部列表选择器都接上了刷新控件"
// 这条接线约定——它正是最容易在下一个节点面板里被漏掉的东西。

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("外部列表选择器的刷新接线", () => {
  it("Inspector 用的是共享 hook 和共享按钮，没有自己再造一个", () => {
    expect(inspectorSource).toContain('from "../../../shared/frontend/hooks/useRefreshableList"');
    expect(inspectorSource).toContain('from "../../../shared/frontend/components/RefreshButton"');
  });

  it("四个外部列表选择器都有各自的刷新按钮提示文案（en + zh）", () => {
    // github.com / youtube.com / x.com 上的数据，用户随时可能在别的标签页里改。
    for (const [en, zh] of [
      ["Reload watched repositories from GitHub", "从 GitHub 重新加载关注的仓库"],
      ["Reload subscriptions from YouTube", "从 YouTube 重新加载订阅"],
      ["Reload playlists from YouTube", "从 YouTube 重新加载播放列表"],
      ["Reload Lists from X", "从 X 重新加载名单"],
    ]) {
      expect(inspectorSource).toContain(en);
      expect(inspectorSource).toContain(zh);
    }
  });

  it("账号选择器的刷新按钮只有一份，住在共享组件里", () => {
    // 五个账号选择器（XTrigger / XContentTrigger / XAction / XContentAction /
    // TikTokContentAction）共用 ChannelAccountField，刷新按钮与提示文案因此只存在一处。
    expect(count(inspectorSource, "Reload linked accounts")).toBe(0);
    expect(count(accountFieldSource, '{ en: "Reload linked accounts", zh: "重新加载已绑定账号" }')).toBe(1);
  });

  it("账号块的 loading 与 error 分支在共享组件里，不会把刷新中/取不到渲染成「尚未绑定」", () => {
    // refresh() 会把 data 清成 null。没有 loading 分支的话，点一下刷新就会闪出
    // "尚未绑定账号"并让当前已选账号从下拉框里消失；没有 error 分支的话，
    // 一次 502 会被渲染成"去绑定账号"，而用户早就绑好了、真正该做的是重试。
    // 三态的实际行为由 channel-account-field.test.tsx 真渲染验证。
    expect(accountFieldSource).toContain("{loading ? (");
    expect(accountFieldSource).toContain("T(ACCOUNT_LIST_LOAD_ERROR)");
    // 五个调用方都必须把三态如实交给共享组件——少传一个，组件就永远看不到那个状态。
    expect(count(inspectorSource, "loading={channelList.loading}")).toBe(5);
    expect(count(inspectorSource, "error={channelList.error}")).toBe(5);
    expect(count(inspectorSource, "onRefresh={channelList.refresh}")).toBe(5);
  });

  it("四个外部列表各有一个刷新按钮，账号那五个的按钮都在共享组件里", () => {
    expect(count(inspectorSource, "<RefreshButton")).toBe(4);
    expect(count(accountFieldSource, "<RefreshButton")).toBe(1);
  });

  it("四个外部列表 + 五个账号都改由 useRefreshableList 取数", () => {
    expect(count(inspectorSource, "useRefreshableList<") + count(inspectorSource, "useRefreshableList(")).toBe(9);
    // 这四个取数不再是 useEffect(..., []) 里挂 setState，而是 hook 的 fetcher。
    for (const call of [
      "useRefreshableList(() => api.channels.githubRepos(), [])",
      "useRefreshableList(() => api.channels.youtubeSubscriptions(), [])",
      "useRefreshableList(() => api.channels.youtubePlaylists(), []",
      "useRefreshableList(() => api.channels.xLists(channelId), [channelId]",
    ]) {
      expect(inspectorSource).toContain(call);
    }
  });

  it("账号选择器刷新时先作废 listCached，否则拿回来的还是老 promise", () => {
    expect(inspectorSource).toContain('if (reason === "refresh") api.channels.invalidateListCache(channelType);');
  });
});

describe("GitHub 仓库选择器的 All Activity 说明", () => {
  it("en + zh 都在，且解释了为什么 Custom 的 Watch 看不见", () => {
    // /user/subscriptions 只返回 All Activity 的 Watch，Custom → Releases only 在这个
    // 接口里根本不存在。不写这句，设了 Custom 的用户看到的是一个没有解释的空列表。
    expect(inspectorSource).toContain("Only repositories you watch with “All Activity” appear here.");
    expect(inspectorSource).toContain("只有以「All Activity」方式 Watch 的仓库会出现在这里。");
  });
});
