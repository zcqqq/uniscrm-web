// https://docs.x.com/x-api/activity/introduction
import type { UserMetadata, ContentMetadata } from "./dataTypes";

export const UserMetadata_X: UserMetadata[] = [
  {
    // 「拉自己的粉丝列表」这个**轮询**已经停用（不能增量、太费钱：
    // GET /2/users/:id/followers 只有 max_results + pagination_token，没有任何增量参数，
    // 而 X 的 owned read 按返回条数计费，等于每天把整份粉丝表重新买一遍）。开关在
    // link/src/services/pollers/x-followers.ts 的 FOLLOWERS_POLLING_ENABLED。
    // 但这份 metadata 必须留着：它描述的是 **X user 对象的字段映射**，webhook 入库
    // （services/users.ts 的 X_USER_META，处理 follow.follow / follow.followed）同样靠它。
    // 删掉的话 webhook 进来的用户会一个结构化字段都不写，全部糊进 raw_data。
    sourceUserType: "own:get-followers", // https://docs.x.com/x-api/users/get-followers
    linkPrefix: "data[]",
    userProps: [
      { propId: "source_user_id", dataId: "{linkPrefix}.id" },
      { propId: "name", dataId: "{linkPrefix}.name" },
      { propId: "username", dataId: "{linkPrefix}.username" },
      { propId: "is_followed", value: 1 },
      { propId: "description", dataId: "{linkPrefix}.description" },
      { propId: "profile_image_url", dataId: "{linkPrefix}.profile_image_url" },
      { propId: "followers_count", dataId: "{linkPrefix}.public_metrics.followers_count" },
      { propId: "following_count", dataId: "{linkPrefix}.public_metrics.following_count" },
      { propId: "post_count", dataId: "{linkPrefix}.public_metrics.tweet_count" },
      { propId: "listed_count", dataId: "{linkPrefix}.public_metrics.listed_count" },
      { propId: "like_count", dataId: "{linkPrefix}.public_metrics.like_count" },
      { propId: "media_count", dataId: "{linkPrefix}.public_metrics.media_count" },
      { propId: "verified_type", dataId: "{linkPrefix}.verified_type" },
    ],
  },
];

export const ContentMetadata_X: ContentMetadata[] = [
  {
    sourceContentType: "own:get-posts", // https://docs.x.com/x-api/users/get-posts author_id=source_channel_id
    flowType: "content",
    linkPrefix: "data[]",
    price:0.001,
    label: {"en":"Own Posts", "zh":"自己的推文"},
    contentProps: [
      { propId: "content_type", value: "TWEET" },  //ARTICLE，参见uniscrm-web/_reference/x/post.json
      { propId: "source_content_id", dataId: "{linkPrefix}.id" },
      { propId: "source_created_at", dataId: "{linkPrefix}.created_at" },
      { propId: "title", dataId: "{linkPrefix}.article.title" },
      { propId: "content_text", dataId: "{linkPrefix}.text" },
      { propId: "bookmark_count", dataId: "{linkPrefix}.public_metrics.bookmark_count" },
      { propId: "view_count", dataId: "{linkPrefix}.public_metrics.impression_count" },
      { propId: "like_count", dataId: "{linkPrefix}.public_metrics.like_count" },
      { propId: "quote_count", dataId: "{linkPrefix}.public_metrics.quote_count" },
      { propId: "reply_count", dataId: "{linkPrefix}.public_metrics.reply_count" },
      { propId: "repost_count", dataId: "{linkPrefix}.public_metrics.retweet_count" },
    ],
  },
  {
    sourceContentType: "get-list-posts", // https://docs.x.com/x-api/lists/get-list-posts
    linkPrefix: "data[]",
    flowType: "trigger",
    price:0.005,
    label: {"en":"List Posts", "zh":"列表的推文"},
    contentProps: [
      { propId: "source_content_id", dataId: "{linkPrefix}.id" },
      { propId: "source_created_at", dataId: "{linkPrefix}.created_at" },
      { propId: "title", dataId: "{linkPrefix}.article.title" },
      { propId: "content_text", dataId: "{linkPrefix}.text" },
      { propId: "bookmark_count", dataId: "{linkPrefix}.public_metrics.bookmark_count" },
      { propId: "view_count", dataId: "{linkPrefix}.public_metrics.impression_count" },
      { propId: "like_count", dataId: "{linkPrefix}.public_metrics.like_count" },
      { propId: "quote_count", dataId: "{linkPrefix}.public_metrics.quote_count" },
      { propId: "reply_count", dataId: "{linkPrefix}.public_metrics.reply_count" },
      { propId: "repost_count", dataId: "{linkPrefix}.public_metrics.retweet_count" },
    ],
    // 作者字段：X API v2 的 expansions 不额外计费也不额外消耗调用配额，作者对象与推文在
    // 同一个响应的 includes.users[] 里（见 x-posts-api.ts 的 fetchListPostsPage）。
    // dataId 相对作者对象本身，不带 {linkPrefix}。
    // 不含 is_followed：UserMetadata_X 里它是写死的 { value: 1 }（那份 metadata 是给
    // 「拉自己的粉丝列表」用的，拉到的当然都是粉丝），照抄会让每个列表作者恒等于"我的
    // 粉丝"。X 的 user 对象里也没有这个信息——"你有没有关注他"只存在于我们自己的库里。
    userProps: [
      { propId: "source_user_id", dataId: "id" },
      { propId: "name", dataId: "name" },
      { propId: "username", dataId: "username" },
      { propId: "description", dataId: "description" },
      { propId: "profile_image_url", dataId: "profile_image_url" },
      { propId: "verified_type", dataId: "verified_type" },
      { propId: "followers_count", dataId: "public_metrics.followers_count" },
      { propId: "following_count", dataId: "public_metrics.following_count" },
      { propId: "post_count", dataId: "public_metrics.tweet_count" },
      { propId: "listed_count", dataId: "public_metrics.listed_count" },
      { propId: "like_count", dataId: "public_metrics.like_count" },
      { propId: "media_count", dataId: "public_metrics.media_count" },
    ],
  },
  {
    sourceContentType: "create-bookmark", // https://docs.x.com/x-api/users/create-bookmark
    flowType: "action",
    price:0.005,
    label: {"en":"Bookmark", "zh":"加入书签"},
    description: {"en":"Bookmarks via the triggering channel", "zh":"通过触发该内容的账号加入书签"},
    contentProps: [
    ],
  },
  {
    sourceContentType: "like-post", // https://docs.x.com/x-api/users/like-post Enterprise-only
    flowType: "action",
    price:0.015,
    label: {"en":"Like", "zh":"点赞"},
    description: {"en":"Likes via the triggering channel", "zh":"通过触发该内容的账号点赞"},
    contentProps: [
    ],
  },
  {
    sourceContentType: "repost-post", // https://docs.x.com/x-api/users/repost-post
    flowType: "action",
    price:0.015,
    label: {"en":"Repost", "zh":"转发"},
    description: {"en":"Reposts via the triggering channel", "zh":"通过触发该内容的账号转发"},
    contentProps: [
    ],
  },
  {
    sourceContentType: "create-post", // https://docs.x.com/x-api/posts/create-post
    flowType: "action",
    price:0.010,
    label: {"en":"Create Post", "zh":"发推文"},
    description: {"en":"Publish a new post via the triggering channel", "zh":"通过触发该内容的账号发布新推文"},
    contentProps: [
      {propId: "message_text", aiType:"TEXT"},
      {propId: "message_video", aiType:"VIDEO"},
    ],
  },
];
