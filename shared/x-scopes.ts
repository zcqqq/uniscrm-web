// x既可以注册账号、也要授权应用，所以scope放到shared
export const X_CHANNEL_SCOPES = [
  "tweet.read", "tweet.write", "users.read", "follows.read", "follows.write",
  "dm.read", "dm.write", "like.read", "list.read", "space.read",
  "bookmark.read", "mute.read", "mute.write", "offline.access",
  "media.write",
];
