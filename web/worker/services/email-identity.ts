// 邮箱在实践中大小写不敏感，但这个仓库此前在三个地方各自实现了一遍「怎么算同一个邮箱」：
// login-throttle 按 trim+小写 计数、密码登录的 SELECT 绑定用户原样输入的字符串、0010 迁移建的
// 唯一索引又是逐字节比较。三者对不上时，magic link 建号时敲的大写形式会让后续密码登录的 SELECT
// 永远查无此人——而且限流计数器用的是小写键，所以受害者会先看到「密码不对」，攒够 5 次后连打对
// 的大小写也进不去，且自己完全看不出原因。
//
// 修法是把 email 当成一个统一的标识：所有会写入或查询 members/tenants 邮箱列的地方都必须先经过
// 这个函数，不要各自内联 .trim().toLowerCase()。
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
