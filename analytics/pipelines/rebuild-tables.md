# R2 Data Catalog 表重建步骤

Pipeline sink 的 schema 不可修改,且拒绝写入已存在的 Iceberg 表。所以加列必须:
**旁置旧表 → 删旧 pipeline → 删旧 sink → 删旧 stream → 用新 schema 建 stream/sink/pipeline**。
删除顺序必须是 pipeline 在先(pipeline 引用 sink,sink 引用不到就删不掉;同理 sink 要在
stream 之前删)。旁置(而不是 drop)只是为了腾出表名,旁置副本不再被任何代码读取。

对 `user` / `content` / `event` 各做一遍。以 dev 的 `user` 为例
(prod 把 `-dev` 后缀去掉、bucket/warehouse 换成 prod 的、account_id 不变):

```bash
export WRANGLER_R2_SQL_AUTH_TOKEN=<R2 API token>   # 与 wrangler OAuth session 是分开的
export R2_CATALOG_TOKEN=<同一个 token,rename-table.py 读这个变量,取不到会退回读 analytics/.dev.vars>

# 0. 先查旁置脚本要用的 catalog prefix —— 它不是 namespace,也不是 bucket 名,
#    是一个和 warehouse 绑定的 UUID,dev/prod 不一样,必须现查,不能照抄下面的例子。
#    Cloudflare 边缘会拒绝 urllib/curl 默认 UA(报 1010),所以要显式带 User-Agent。
curl -s -H "Authorization: Bearer $R2_CATALOG_TOKEN" -H "User-Agent: curl/8.7.1" \
  "https://catalog.cloudflarestorage.com/b34f3ff4aec4c36584672d5bf1320757/uniscrm-dev/v1/config?warehouse=b34f3ff4aec4c36584672d5bf1320757_uniscrm-dev"
# 返回 JSON 里的 overrides.prefix 就是要用的值。
# dev 现在(2026-07-25)是 08ca766c-714a-11f1-8000-77e532ac8d4b —— 仅供参考,
# prod 或以后重建时必须重新查,不要直接照抄。

# 1. 旁置旧表(脚本已存在,五个位置参数:account_id bucket prefix src_table dst_table)
python3 analytics/pipelines/rename-table.py \
  b34f3ff4aec4c36584672d5bf1320757 uniscrm-dev \
  08ca766c-714a-11f1-8000-77e532ac8d4b \
  user user_v1

# 2. 删旧 pipeline → sink → stream(非交互 shell 必须加 -y,否则卡在确认提示;
#    顺序反了会因为还有引用而删不掉)
wrangler pipelines delete uniscrm-user-dev -y
wrangler pipelines sinks delete uniscrm-user-sink-dev -y
wrangler pipelines streams delete uniscrm-user-stream-dev -y

# 3. 用新 schema 建 stream —— 记下命令打印出的 stream ID,第 6 步要用
wrangler pipelines streams create uniscrm-user-stream-dev \
  --schema-file analytics/pipelines/user-stream-schema.json

# 4. 建 sink（指向 uniscrm.user)。
#    刻意不传 --access-key-id / --secret-access-key,让 sink 自动生成一套新的
#    R2 凭证 —— 传旧凭证会导致写入时报 signature mismatch。
wrangler pipelines sinks create uniscrm-user-sink-dev \
  --type r2-data-catalog --bucket uniscrm-dev \
  --namespace uniscrm --table user \
  --catalog-token "$R2_CATALOG_TOKEN" --roll-interval 300

# 5. 建 pipeline 串起来(create 只有一个 positional + --sql/--sql-file,
#    没有 --stream/--sink 这两个 flag,SQL 里的表名就是 stream/sink 的名字)
wrangler pipelines create uniscrm-user-dev \
  --sql "INSERT INTO uniscrm-user-sink-dev SELECT * FROM uniscrm-user-stream-dev"

# 6. link/wrangler.toml 里的 pipelines binding 绑定的是 stream **ID**,不是名字
#    (如 stream = "b2a9528928814147a6dfa742b8319d92")。第 3 步重建 stream 后
#    ID 一定会变,必须把 PIPELINE_USER 对应 env 段(env.dev 或 env.production)
#    的 stream = "..." 替换成第 3 步打印出的新 ID,不是"确认"一下就行——
#    不换的话 worker 会继续往已删除的旧 stream 写,静默失败。
#    改完部署(注意带 --env dev,裸 wrangler deploy 会打到 PRODUCTION 并且会
#    抹掉那个 worker 的 bindings):
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

务必用 `COUNT(DISTINCT id)`,不要用 `COUNT(*)` —— Pipelines 是 at-least-once
投递,同一条记录的 UUID 在这几张表里出现过重复,`COUNT(*)` 会把重复行也算进去。
