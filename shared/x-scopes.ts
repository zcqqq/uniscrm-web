// x既可以注册账号、也要授权应用，所以scope放到shared
// 系统默认App只服务metadata/x.ts里的功能（关注/私信/静音 + 帖子创建·点赞事件订阅）。
// metadata/x-byok.ts里的内容类action（create-post/like-post/bookmark/repost等）
// 按设计只通过BYOK channel执行（见link/src/services/app-credentials.ts的X_BYOK_SCOPES），
// 所以tweet.write/like.write/bookmark.write/list.read/media.write不放在这里。
export const X_CHANNEL_SCOPES = [
  "tweet.read", "users.read", "follows.read", "follows.write",
  "dm.read", "dm.write", "like.read", "mute.write", "offline.access",
];
