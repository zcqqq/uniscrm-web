```mermaid
sequenceDiagram
    participant Link as link Worker
    participant Flow as flow Worker
    participant Pipeline as Cloudflare Pipelines
    participant R2 as R2 Iceberg (uniscrm-dev)
    participant Frontend as Frontend
    participant IA as insight-analytics Worker
    participant Queue as Queue (analytics-jobs)
    participant Container as AnalyticsContainer
    participant D1 as D1 (uniscrm-db)

    Note over Link,R2: Write Path (real-time)
    Link->>Pipeline: PIPELINE_EVENT.send([{tenant_id, id, user_id, event_type, ...}])
    Link->>Pipeline: PIPELINE_USER.send([{tenant_id, id, name, username, ...}])
    Flow->>Pipeline: PIPELINE_FLOW_NODE_LOG.send([{tenant_id, flow_id, node_id, ...}])
    Pipeline->>R2: Batch → Parquet → Iceberg table

    Note over Frontend,D1: Query Path (async report)
    Frontend->>IA: POST /api/reports {type: "interval", params}
    IA->>D1: INSERT analytics_reports (status='pending')
    IA->>Queue: send({report_id, type, params, tenant_id, warehouse})
    IA-->>Frontend: {id, status: "pending"}

    Queue->>IA: queue consumer receives message
    IA->>D1: UPDATE status='computing'
    IA->>Container: startAndWaitForPorts()
    IA->>Container: POST /query {sql, warehouse}
    Container->>R2: wrangler r2 sql query
    R2-->>Container: query results
    Container-->>IA: {data: [...]}
    IA->>D1: UPDATE status='ready', results_json=...

    Frontend->>IA: GET /api/reports/:id (polling)
    IA->>D1: SELECT status, results_json
    IA-->>Frontend: {status: "ready", results: {...}}
```
