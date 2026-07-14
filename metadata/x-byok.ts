// https://docs.x.com/x-api/activity/introduction
import type { UserMetadata , ContentMetadata} from "./dataTypes";

export const UserMetadata_X: UserMetadata[] = [
  {
    sourceUserType: "get-followers", // https://docs.x.com/x-api/users/get-followers
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
    sourceContentType: "get-posts", // https://docs.x.com/x-api/users/get-posts author_id=source_channel_id
    linkPrefix: "data[]",
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
];
