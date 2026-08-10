-- link/migrations/0010_cron_state.sql
-- 跨 cron 轮次的小标量状态。第一个（也是目前唯一的）用户是 GitHub release 轮询的环形
-- 轮转位点 name='github_releases_rotation'：每小时的预算只够处理清单的一段，位点记住上一轮
-- 停在哪，下一轮从那之后继续、走到头绕回开头，从而保证任何 (channel, repo) 最多等
-- ceil(N/B) 轮就必被轮询到 —— 没有它，预算边界之后的租户是永远不被轮询，不是晚一点。
--
-- 故意不复用 channel_poll_state：那张表的主键是 (channel_id, poller_name)，而轮转位点不
-- 属于任何单个 channel，硬塞会造出一行永远对不上 channels 的孤儿。
CREATE TABLE IF NOT EXISTS cron_state (
  name TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
