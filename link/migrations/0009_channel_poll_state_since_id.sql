-- link/migrations/0009_channel_poll_state_since_id.sql
-- posts 增量轮询的水位：上一轮见过的最新 Post id，下一轮作为 GET /2/users/:id/tweets
-- 的 since_id 传回去，没有新帖就返回 0 条。
-- 为什么需要：X 的 owned read 按返回的资源条数计费（$0.001/条，同一 UTC 日内同一条去重），
-- 不带 since_id 时每天第一次轮询都会把整份自有帖重新计费一遍。
-- 只对 poller_name = 'posts' 有意义；followers 那条链路没有任何增量参数可用（
-- GET /2/users/:id/followers 只有 max_results + pagination_token），因此不适用。
ALTER TABLE channel_poll_state ADD COLUMN since_id TEXT;
