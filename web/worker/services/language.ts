import type { Locale } from "../../../metadata/locale";

// 挑选新 member 建号时的界面语言。members.language 只在注册这一刻写一次，绝大多数人从不打开
// Settings 改它，所以这个值决定了他们此后看到的整个产品是什么语言。
//
// 在此之前这一列根本没被写过，直接吃建表默认值 'en'（web/migrations/0001_init.sql），于是每个
// 中文用户注册完都落在英文界面里 —— 2026-08-20 租户 100005 付款失败时就是这样：Stripe 收银台
// 跟着浏览器语言显示中文，被打回我们的 /billing 却是英文，客户以为「页面变成英文了」。
//
// 信号取浏览器自己发的 Accept-Language 头，三条建号路径都带着它：magic link 点开、OAuth 回调的
// 浏览器跳转、以及 /oauth/complete-profile 这个 XHR（Accept-Language 是浏览器强制附加的头，
// 页面 JS 既覆盖不了也去不掉）。这也是它不像 timezone 那样需要前端显式传参的原因 —— 时区没有
// 对应的请求头，语言有。
export function resolveSignupLanguage(acceptLanguage?: string | null): Locale {
  if (!acceptLanguage) return "en";

  const tags = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((entry) => entry.tag && entry.q > 0)
    // Array#sort 是稳定排序，q 相同的标签保持请求头里的原始先后。
    .sort((a, b) => b.q - a.q);

  for (const { tag } of tags) {
    // 只看主语言子标签：zh-CN / zh-TW / zh-Hant-HK 一律归到 zh。我们只有简体一套文案，
    // 给繁体用户简体中文也远好过甩给他们英文。
    const primary = tag.split("-")[0];
    if (primary === "zh") return "zh";
    if (primary === "en") return "en";
  }

  // 既不是中文也不是英文（或者只有 "*" 通配）时回落英文，与建表默认值一致。
  return "en";
}
