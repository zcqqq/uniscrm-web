```mermaid
sequenceDiagram
    participant LW as link Worker
    participant EQ as Queue: uniscrm-event
    participant FW as flow Worker
    participant PLG as Pipeline: PIPELINE_FLOW_LOG
    participant LQ as Queue: uniscrm-flow-log
    participant TDB as Tenant D1

    LW->>EQ: 事件入队
    EQ->>FW: 消费事件，执行flow
    FW->>PLG: 节点日志写入 R2 Iceberg
    FW->>LQ: 节点日志入队
    LQ->>FW: 批量消费日志
    FW->>TDB: 写入 flow_log 表
```

## Content-triggered flows

```mermaid
sequenceDiagram
    participant P as link Worker (poller)
    participant CS as ContentService
    participant EQ as Queue: uniscrm-event
    participant FW as flow Worker
    participant CFP as content_flow_pending
    participant STUB as link internal (stub)

    P->>CS: upsertContentFromMetadata(..., emitFlowEvent)
    CS->>CS: isNew && emitFlowEvent?
    CS->>EQ: content.created { contentId, channelId, payload }
    EQ->>FW: queue() dispatches on contentId
    FW->>FW: executeFlow (contentTrigger match)
    alt has wait/timeCondition/abSplit downstream
        FW->>CFP: INSERT content_flow_pending
        Note over FW,CFP: resumed later by scheduled() sweep
    end
    FW->>STUB: repost / xContentAction (stub, 501)
    FW->>FW: INSERT content_flow_executions
```

## Content-domain: xContentAction (real generation + publish)

The `xContentAction` call above is no longer a 501 stub. This diagram replaces
that leg with the real path: `flow` interpolates `$content.xxx` into the node's
prompt itself, then calls `link`'s `create-post` handler, which (unless
`provider` is `"none"`) calls `content` to generate the final text, then posts
it to X, then `flow` resolves the graph's success/failed branch — including
the rate-limit retry loop via `content_flow_pending`. `link` no longer queries
the source `content` row itself — `flow` already resolved the final prompt
text before this call.

```mermaid
sequenceDiagram
    participant FW as flow Worker
    participant LW as link Worker
    participant CW as content Worker
    participant XAPI as X API
    participant TDB as Tenant D1
    participant CFP as content_flow_pending

    FW->>FW: interpolate $content.xxx into node's prompt -> interpolatedPrompt
    FW->>LW: POST /internal/content/create-post { contentId, interpolatedPrompt, provider, targetChannelId, flowId }
    alt provider !== "none"
        LW->>CW: POST /internal/generate { tenantId, prompt: interpolatedPrompt, provider }
        CW-->>LW: { text }
    else provider === "none"
        Note over LW: skip content entirely, text = interpolatedPrompt verbatim
    end
    alt targetChannel.channel_type === "X"
        LW->>XAPI: POST /2/tweets
        XAPI-->>LW: { id } | 429 rate limited | error
    else other channel_type (e.g. TikTok)
        Note over LW: out of scope this phase, returns { ok:false }
    end
    opt posted successfully
        LW->>TDB: recordPublishedContent(targetChannelId, "X", postId, text, ...)
    end
    LW-->>FW: { ok:true } | { ok:false } | { ok:false, rateLimited:true, rateLimitReset }
    alt rateLimited
        FW->>CFP: INSERT content_flow_pending (retry_action, retry_count: 0)
        Note over FW,CFP: scheduled() sweep retries at rateLimitReset;<br/>retry_count < 5 reschedules;<br/>retry_count >= 5 resolves resumeFromNode(graph, nodeId, payload, "failed") before deleting the row<br/>(per flow/CLAUDE.md's "重试耗尽后才走failed分支" rule)
    else resolved (ok or non-rate-limited failure)
        FW->>FW: resumeFromNode(graph, nodeId, payload, ok ? "success" : "failed")
        opt resumed branch includes updateContentStatus action
            FW->>TDB: UPDATE content SET status = 'published'|'ignored' WHERE id = contentId
        end
    end
```
