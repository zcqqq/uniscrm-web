-- 密码是加在既有账号上的第二种凭证，永远不是一条注册路径。NULL 表示这个 member 至今只用过
-- magic link 或 OAuth。
ALTER TABLE members ADD COLUMN password_hash TEXT;

-- 密码登录要按邮箱把人查出来，所以邮箱必须唯一标识一行。在此之前它只有一个普通索引
-- （0001_init.sql:47），一旦出现重复行就会登进其中任意一个账号。加索引前已核实 dev（8 行）与
-- 生产（3 行）均无重复邮箱、无 NULL。
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_email_unique ON members(email);
