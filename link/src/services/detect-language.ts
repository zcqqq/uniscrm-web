// 视频语言的推导。三级：上传者声明的口语语言 → 上传者声明的元数据语言 → 标题+描述的
// 脚本判定。全部零 API 成本——前两个来自 videos.list 已经在打的 part=snippet，第三个
// 来自 payload 里本就有的 title / content_text。
//
// 这里刻意**不做**概率式语种识别。脚本区间判定（假名→ja、谚文→ko、西里尔→ru）是确定性的；
// 而拉丁字母系要分 en/es/fr/de 只能靠 n-gram 统计，在一个 40 字的标题上接近掷硬币，
// 判错还是静默的——用户的 "语言 == 英语" 会通过，内容却发给了错的受众。所以拉丁字母
// 一律不出值，交给 LANGUAGE_UNKNOWN。真要区分拉丁语种时再引库，不是现在。

// 判不出时写进 payload 的哨兵值。**绝不留空**：flow/src/engine.ts 的 evaluateCondition
// 在进算子分支之前就 `actual == null → return false`，留空会让 "语言 != 日语" 在判不出
// 语言的视频上返回 false（视频被挡掉），与"只想排掉日语"的意图正好相反。写了哨兵，
// "unknown" != "ja" → true，判不出的视频照常放行；想收紧的人自己再加一条 != 未知。
// 附带好处：flow/src/youtube-condition.ts 的 stat_unavailable 守卫（字段在 payload 里
// 有、在新取回的 props 里没有 → failed 分支）永远不会被这个字段误触发。
export const LANGUAGE_UNKNOWN = "unknown";

// "no linguistic content" / "undetermined"。YouTube 对纯音乐、无语音的视频会填 zxx。
// 它是合法的 BCP-47 标签，但不是一个语言——当语言值传下去，用户会在条件里看到一个
// 不存在的语种。按"没声明"处理，继续往下一级推。
const NON_LANGUAGE_TAGS = new Set(["zxx", "und", "mul"]);

// BCP-47 → 主子标签，小写。"ja-JP" → "ja"，"zh-Hant-TW" → "zh"。
// 不归一的话，enum 里用户选的 "ja" 与 API 返回的 "ja-JP" 在 engine 的字符串严格比较下
// 永远不等，条件静默失效。
export function normalizeLanguageTag(tag: unknown): string | null {
  if (typeof tag !== "string") return null;
  const primary = tag.trim().toLowerCase().split("-")[0];
  // 主子标签是 2-3 个字母（ISO 639-1/2/3）。其它形状（空串、纯数字、"x" 私有标签）不认。
  if (!/^[a-z]{2,3}$/.test(primary)) return null;
  if (NON_LANGUAGE_TAGS.has(primary)) return null;
  return primary;
}

// 单个脚本要定性所需的最少字符数，以及它在"有语言信息的字符"里的最低占比。
// 两道门槛都是为了挡住零星混入：英文标题里带一个中文地名（"Travel guide to 北京"）
// 不该被判成中文。0.2 是经验值——足够低到不误杀"日文标题 + 英文副标题"这种常见排版
// （实测样本 CNCBp0XZiN8 约 0.39），又足够高到挡住一两个装饰性字符。
const MIN_SCRIPT_CHARS = 2;
const MIN_SCRIPT_RATIO = 0.2;

// 描述里塞满链接是常态。URL 全是拉丁字母，不剥掉的话一段短日文描述会被链接稀释到
// 阈值以下，判成 unknown。
const URL_RE = /https?:\/\/\S+/g;

const SCRIPT_RANGES = {
  // 平假名 + 片假名 + 半角片假名。假名是日语的充分条件——中文和韩文都不用它。
  kana: /[぀-ヿｦ-ﾝ]/g,
  // 谚文音节 + 字母 + 兼容字母。
  hangul: /[가-힣ᄀ-ᇿ㄰-㆏]/g,
  // CJK 统一表意文字（含扩展 A）。日中韩共用，所以必须排在假名/谚文之后判。
  han: /[一-鿿㐀-䶿]/g,
  cyrillic: /[Ѐ-ӿ]/g,
  arabic: /[؀-ۿݐ-ݿ]/g,
  latin: /[a-zÀ-ɏ]/gi,
} as const;

function count(text: string, re: RegExp): number {
  return (text.match(re) || []).length;
}

// 脚本判定。返回 null = 判不出（拉丁字母系、纯数字/符号、信号不足）。
// 顺序不能改：日文正文里汉字与假名混排，先判假名才不会把日语误判成中文。
export function detectScriptLanguage(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const stripped = text.replace(URL_RE, " ");
  const kana = count(stripped, SCRIPT_RANGES.kana);
  const hangul = count(stripped, SCRIPT_RANGES.hangul);
  const han = count(stripped, SCRIPT_RANGES.han);
  const cyrillic = count(stripped, SCRIPT_RANGES.cyrillic);
  const arabic = count(stripped, SCRIPT_RANGES.arabic);
  const latin = count(stripped, SCRIPT_RANGES.latin);

  // 日语的信号是假名+汉字一起算：一句日文里汉字占比不低，只用假名去和拉丁字母比
  // 会低估它。判定条件仍是"有假名"——汉字自己不足以指向日语。
  const candidates: [string, number, number][] = [
    ["ja", kana, kana + han],
    ["ko", hangul, hangul],
    ["zh", han, han],
    ["ru", cyrillic, cyrillic],
    ["ar", arabic, arabic],
  ];

  for (const [lang, trigger, signal] of candidates) {
    if (trigger < MIN_SCRIPT_CHARS) continue;
    if (signal / (signal + latin) < MIN_SCRIPT_RATIO) continue;
    return lang;
  }
  return null;
}

export interface VideoLanguageInput {
  // videos.list 的 snippet.defaultAudioLanguage —— 上传者声明的**口语**语言，最权威。
  defaultAudioLanguage?: unknown;
  // snippet.defaultLanguage —— 上传者声明的标题/描述语言。语义上是元数据语言而非口语
  // 语言，所以只当二级兜底。
  defaultLanguage?: unknown;
  title?: unknown;
  description?: unknown;
}

// 永远返回一个非空字符串——判不出就是 LANGUAGE_UNKNOWN，理由见该常量的注释。
// 返回值不受 metadata 里 enum 短表的约束：下拉框约束的是"用户能选什么"，不是
// "payload 里能有什么"。一个葡萄牙语视频必须真的带 "pt"，"语言 != 日语" 才能正确放行它。
export function resolveVideoLanguage(input: VideoLanguageInput): string {
  const declared =
    normalizeLanguageTag(input.defaultAudioLanguage) ?? normalizeLanguageTag(input.defaultLanguage);
  if (declared) return declared;

  const title = typeof input.title === "string" ? input.title : "";
  const description = typeof input.description === "string" ? input.description : "";
  return detectScriptLanguage(`${title}\n${description}`) ?? LANGUAGE_UNKNOWN;
}
