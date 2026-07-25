# R2 Data Catalog 表重建步骤

Pipeline sink 的 schema 不可修改,且拒绝写入已存在的 Iceberg 表。所以加列必须:
**旁置旧表 → 删旧 pipeline/sink/stream → 用新 schema 建 stream/sink/pipeline**。
旁置(而不是 drop)只是为了腾出表名,旁置副本不再被任何代码读取。

对 `user` / `content` / `event` 各做一遍。以 dev 的 `user` 为例
(prod 把 `-dev` 后缀去掉、warehouse 换成 prod 的):

```bash
export WRANGLER_R2_SQL_AUTH_TOKEN=<R2 API token>   # 与 wrangler OAuth session 是分开的

# 1. 旁置旧表(脚本已存在)
python3 analytics/pipelines/rename-table.py --namespace uniscrm --from user --to user_v1

# 2. 删旧 pipeline / sink / stream(非交互 shell 必须加 -y,否则卡在确认提示)
wrangler pipelines delete uniscrm-user-dev -y
wrangler pipelines sinks delete uniscrm-user-sink-dev -y
wrangler pipelines streams delete uniscrm-user-stream-dev -y

# 3. 用新 schema 建 stream
wrangler pipelines streams create uniscrm-user-stream-dev \
  --schema-file analytics/pipelines/user-stream-schema.json

# 4. 建 sink（指向 uniscrm.user)
wrangler pipelines sinks create uniscrm-user-sink-dev \
  --type r2-data-catalog --bucket uniscrm-dev \
  --namespace uniscrm --table user

# 5. 建 pipeline 串起来
wrangler pipelines create uniscrm-user-dev \
  --stream uniscrm-user-stream-dev --sink uniscrm-user-sink-dev \
  --sql "INSERT INTO uniscrm-user-sink-dev SELECT * FROM uniscrm-user-stream-dev"

# 6. 确认 link/wrangler.toml 的 PIPELINE_USER 指向新 stream,然后
wrangler deploy --env dev --config link/wrangler.toml
```

新 sink 是**懒创建表**:第一次写入之前 `wrangler r2 sql query` 会报
`40010: iceberg table not found`,这是正常的全新状态,不是错误。

验证(写入一条后):

```bash
wrangler r2 sql query b34f3ff4aec4c36584672d5bf1320757_uniscrm-dev \
  "SELECT COUNT(DISTINCT id) FROM uniscrm.user WHERE tenant_id = 1"
```

`wrangler r2 sql query` 的第一个参数是 **warehouse 标识符**(各模块 wrangler.toml 的
`R2_WAREHOUSE`),不是 bucket 名;传错会报 "Warehouse name has invalid format"。
另注意它出错时仍可能 exit 0,务必肉眼看输出。
