// https://docs.x.com/x-api/activity/introduction
import type { UserMetadata, ContentMetadata } from "./dataTypes";

export const UserMetadata_X: UserMetadata[] = [
  {
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
    ],
  },
];

export const ContentMetadata_X: ContentMetadata[] = [
  {
    sourceContentType: "own:get-posts", // https://docs.x.com/x-api/users/get-posts author_id=source_channel_id
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
      { propId: "content_type", value: "TWEET" },
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
