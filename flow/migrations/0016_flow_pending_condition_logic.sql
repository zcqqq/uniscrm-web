-- flow_pending.conditions 是建 wait 时的快照（不是 live graph），resume 时在原子 claim 之前
-- 读取。AND/OR 逻辑必须与条件同源快照，否则用户在等待期间编辑 flow 会造成"旧条件 + 新逻辑"。
-- 空串 = AND（与缺省、"and"、任何畸形值同义），存量行自动正确，无需数据迁移。
ALTER TABLE flow_pending ADD COLUMN condition_logic TEXT NOT NULL DEFAULT '';
