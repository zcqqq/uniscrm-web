// https://docs.github.com/en/rest/releases/releases#list-releases
// https://docs.github.com/en/rest/repos/repos#get-a-repository
import type { ContentMetadata } from "./dataTypes";

// watch:get-releases 是 flowType:"trigger"（见设计 D2）—— Watch 的是**别人的** repo，
// 和 X 的 get-list-posts、YouTube 的 watch:get-videos 同类：只驱动 flow，不进 content 表。
// 轮询器因此只调 recordTriggerContentSeen + emitContentTriggerEvent，永不调
// upsertContentFromMetadata（后者对非 "content" 的 flowType 直接抛错）。
export const ContentMetadata_GitHub: ContentMetadata[] = [
  {
    sourceContentType: "watch:get-releases",
    flowType: "trigger",
    label: { en: "Watched Repo Releases", zh: "关注仓库的发版" },
    // 无 linkPrefix：轮询器逐条喂 /releases 的 item，不是整个响应体。
    contentProps: [
      { propId: "content_type", value: "RELEASE" },
      { propId: "source_content_id", dataId: "id" },
      { propId: "source_created_at", dataId: "published_at" },
      // 很多 repo 不填 release name，轮询器在 resolveProps 之后回退到 tag_name。
      { propId: "title", dataId: "name" },
      { propId: "content_text", dataId: "body" },
      { propId: "content_url", dataId: "html_url" },
      { propId: "tag_name", dataId: "tag_name" },
      // GitHub 返回布尔，轮询器归一成 0/1（ENUM_INT）。
      { propId: "is_prerelease", dataId: "prerelease" },
      // 只声明不给 dataId/value：resolveProps 会跳过，声明的唯一目的是让条件编辑器的
      // 字段列表带上它们（同 metadata/youtube.ts 的 duration）。值由 flow 侧注入 ——
      // 计数口径跟随节点的 includePrerelease，轮询器看不到节点配置。
      { propId: "release_count_1d" },
      { propId: "release_count_7d" },
      { propId: "release_count_30d" },
      // 1 天窗口内、带文本的 release 列表——JSON 数组字符串，每条 {title, content_text}
      // 分开存。同样只声明不给 dataId/value：只服务 1 天聚合这一个场景，没有 7d/30d 版本
      // （见 flow/src/github-release-count.ts 的 computeReleaseNotes1d）。
      { propId: "release_notes_1d" },
    ],
    // 作者 = repo 本身（不是 owner，不是 release 的发布者）。dataId 相对 repo 对象，
    // **不走 contentProps 的 linkPrefix** —— /releases 的响应里根本没有 repo 信息
    // （实测确认：没有 stargazers_count、没有 description），必须另打 GET /repos/{o}/{r}。
    // star 数映到 followers_count 而不是新增 star_count：跨渠道归一优先，同 YouTube 把
    // subscriberCount 映到 followers_count。
    userProps: [
      { propId: "source_user_id", dataId: "id" },
      { propId: "name", dataId: "full_name" },
      { propId: "username", dataId: "name" },
      { propId: "description", dataId: "description" },
      { propId: "profile_image_url", dataId: "owner.avatar_url" },
      { propId: "followers_count", dataId: "stargazers_count" },
    ],
  },
];
