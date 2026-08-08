-- 补齐 0013 建表时相对 flow_pending 的漂移：content_flow_pending.conditions 同样是建 wait 时
-- 的快照（不是 live graph），sweep 解析前读取。AND/OR 逻辑必须与条件同源快照，否则用户在
-- 等待期间编辑 flow 会造成"旧条件 + 新逻辑"。
-- 空串 = AND（与缺省、"and"、任何畸形值同义），存量行自动正确，无需数据迁移。
-- 与 0016 给 flow_pending 加的同名列完全对称，两张 pending 表从此保持同构。
ALTER TABLE content_flow_pending ADD COLUMN condition_logic TEXT NOT NULL DEFAULT '';
