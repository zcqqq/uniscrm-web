-- OAuth state 从 Cloudflare KV 挪到 D1。
--
-- KV 是全局最终一致的：写 state 的 /authorize 请求和读 state 的 /callback 请求几乎总落在两个不同
-- 的边缘节点。当 OAuth 往返足够快（账号此前已经同意过、免同意页秒回）时，callback 落地的节点可能
-- 还没看到 authorize 节点刚写入的 state，读到空值就报 "Invalid or expired state"，把一次本该成功
-- 的登录挡下来——重试能成功只是因为重新走了一遍完整授权流程，这次往返凑巧躲过了传播窗口。
-- D1 只有一份权威副本，没有这个窗口。跟 sessions 当年从 KV 挪到 D1 是同一个教训（见 shared/auth.ts
-- 顶部注释）。2026-08-21 排查租户 100005 的注册失败投诉时定位到此。
--
-- 没有专门的过期清理任务：shared/oauth-state.ts 的 storeOAuthState 每次写入时顺带删掉已过期的
-- 行，这张表任何时刻只会有个位数的在途 OAuth 跳转，不值得为此单独起一个 cron。
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_oauth_states_expires_at ON oauth_states(expires_at);
