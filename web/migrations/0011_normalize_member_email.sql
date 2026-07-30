-- 0010 建的唯一索引是逐字节比较的 BINARY 索引，但邮箱在实践中大小写不敏感，而写入路径此前各自
-- trim/小写，没有统一规则：magic-link /verify 存的是用户输入的原样大小写，密码登录的 SELECT 又
-- 绑定原样输入去查。两边对不上时，用大写形式注册、之后打小写登录的人会永远查无此人——限流计数器
-- 还是按小写键计数的，攒够 5 次后连打对原始大小写都进不去，且完全看不出原因。
--
-- 代码侧已统一改为写入/查询前都经过 email-identity.ts 的 normalizeEmail（trim + 小写）。这里把
-- 历史数据也拍平，并把唯一索引换成大小写不敏感版本：这样万一将来又有代码路径忘了 normalize，
-- 唯一约束会直接报错，而不是悄悄建出第二个账号。
--
-- 部署前已核实 dev 与生产环境的 members、tenants 表里都没有邮箱大小写不同于其小写形式的行，下面
-- 的 UPDATE 是空操作，新索引也不会因此撞车。

UPDATE members SET email = TRIM(LOWER(email)) WHERE email != TRIM(LOWER(email));
UPDATE tenants SET email = TRIM(LOWER(email)) WHERE email != TRIM(LOWER(email));

DROP INDEX IF EXISTS idx_members_email_unique;
CREATE UNIQUE INDEX idx_members_email_unique ON members(email COLLATE NOCASE);
