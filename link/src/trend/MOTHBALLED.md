# 封存中（2026-08-08 产品决定）

本目录（trend 聚合：Twitter/TikTok/抖音热点抓取 → KV 缓存 + Vectorize 向量库）已从
`cron.ts` 摘除，不再运行。没有任何 API 路由或前端消费它。

原因：trend 推荐功能尚未排期，而这 630 行代码零测试却带着一个会删数据的
`TrendVectorStore.cleanupOld()` 在 cron 里裸跑。

重新激活时（产品上线 trend 功能）：
1. 恢复 `cron.ts` 里的 `handleTrendAggregation`（见 git 历史，本次摘除的 commit）
2. 先补测试再接回 cron —— 尤其 `cleanupOld` 的保留天数边界
