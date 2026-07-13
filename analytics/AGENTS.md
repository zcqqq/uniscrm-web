# Technical
因为R2 SQL没有API，只有CLI，所以用worker container运行。

## R2 Pipelines / Data Catalog 操作注意事项
- `wrangler pipelines delete/sinks delete/streams delete` 在非交互式 shell 里会卡在确认提示，需要加 `-y`/`--force`。
- `wrangler r2 sql query <warehouse> "<sql>"` 的第一个参数是 warehouse 标识符（如 `b34f3ff4aec4c36584672d5bf1320757_uniscrm-dev`，对应各模块 wrangler.toml 里的 `R2_WAREHOUSE`），不是 bucket 名（`uniscrm-dev`）——传错会报 "Warehouse name has invalid format"。
- `wrangler r2 sql query` 需要单独设置 `WRANGLER_R2_SQL_AUTH_TOKEN` 环境变量（R2 API token），跟其它 `wrangler pipelines`/`r2 bucket catalog` 命令用的 OAuth session 是分开的。
- R2 Data Catalog 的 sink 是懒创建表：新建的 sink 在第一次写入前，对应的 Iceberg table 根本不存在（`wrangler r2 sql query` 会报 `40010: iceberg table not found`），这是正常的"全新、无脏数据"状态，不是错误。