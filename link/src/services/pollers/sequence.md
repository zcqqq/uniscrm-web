# GitHub release → content flow 时序

```mermaid
sequenceDiagram
    participant Cron as link cron (hourly)
    participant Flow as flow /internal/github-watches
    participant GH as GitHub REST
    participant D1 as LINK_DB / entity_state
    participant Q as FLOW_QUEUE
    participant FW as flow queue consumer

    Cron->>Flow: GET /internal/github-watches
    Flow-->>Cron: [{channelId, fullName}]
    loop 每个 (channel, repo)
        Cron->>D1: INSERT OR IGNORE channel_poll_state（自 seed）
        Cron->>D1: SELECT cursor（ETag）
        Cron->>GH: GET /repos/{o}/{r}/releases (If-None-Match)
        alt 304 / 404 / 限流
            GH-->>Cron: 无内容，跳过本 repo
        else 200
            GH-->>Cron: releases[]
            Cron->>D1: UPDATE cursor = 新 ETag
            loop 每条 release
                Cron->>D1: markSeen(content_trigger, channel, repo, releaseId)
            end
            alt seed 阶段
                Note over Cron: 只记不发，随后 backfill_complete = 1
            else 有新 release
                Cron->>GH: GET /repos/{o}/{r}（仅此时才打，取 star 等作者字段）
                Cron->>Q: content.created {repoFullName, payload + release_history}
            end
        end
    end
    Q->>FW: 消费
    FW->>FW: TRIGGER_MATCHERS.githubContentTrigger（含 includePrerelease 过滤）
    FW->>FW: 按节点口径算 release_count_1d/7d/30d，删 release_history
    FW->>FW: conditionsPass → 后续节点
```
