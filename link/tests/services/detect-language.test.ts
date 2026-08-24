import { describe, it, expect } from "vitest";
import {
  LANGUAGE_UNKNOWN,
  normalizeLanguageTag,
  detectScriptLanguage,
  resolveVideoLanguage,
} from "../../src/services/detect-language";

describe("normalizeLanguageTag — 归一到 BCP-47 主子标签", () => {
  it("截掉地区/文字子标签并小写", () => {
    // 条件里用户选的是 "ja"（enum 的 value）。API 返回 "ja-JP" 而不归一，
    // engine 的 `==` 是字符串严格比较，条件就永远不成立。
    expect(normalizeLanguageTag("ja-JP")).toBe("ja");
    expect(normalizeLanguageTag("zh-Hant-TW")).toBe("zh");
    expect(normalizeLanguageTag("EN")).toBe("en");
    expect(normalizeLanguageTag("ru")).toBe("ru");
  });

  it("zxx / und 不是语言，按没声明处理", () => {
    // YouTube 对纯音乐 / 无语音内容会填 zxx（"no linguistic content"）。
    // 把它当成一个语言值传下去，会让 "语言 != 日语" 对一段纯音乐返回 true——
    // 字面没错，但用户看到的是一个不存在的语言。交给下游降级成 unknown。
    expect(normalizeLanguageTag("zxx")).toBeNull();
    expect(normalizeLanguageTag("und")).toBeNull();
  });

  it("非字符串 / 空 / 畸形一律 null", () => {
    expect(normalizeLanguageTag(undefined)).toBeNull();
    expect(normalizeLanguageTag(null)).toBeNull();
    expect(normalizeLanguageTag("")).toBeNull();
    expect(normalizeLanguageTag("   ")).toBeNull();
    expect(normalizeLanguageTag(42)).toBeNull();
    expect(normalizeLanguageTag("-")).toBeNull();
  });
});

describe("detectScriptLanguage — 只在脚本无歧义时出值", () => {
  it("有假名即日语（哪怕混着大量拉丁字母）", () => {
    // 真实样本：youtube.com/watch?v=CNCBp0XZiN8 的标题，日文 + 括号里的英文副标题。
    expect(
      detectScriptLanguage(
        "IQVIAジャパンによるクリニック経営アシストサービス (Clinic management assist service by IQVIA Japan)"
      )
    ).toBe("ja");
  });

  it("汉字 + 假名混排仍是日语，不是中文", () => {
    expect(detectScriptLanguage("東京の新しい経営アシストサービスについて")).toBe("ja");
  });

  it("只有汉字没有假名 → 中文", () => {
    expect(detectScriptLanguage("北京旅游攻略：三天两夜怎么玩")).toBe("zh");
  });

  it("谚文 → 韩语", () => {
    expect(detectScriptLanguage("서울 여행 브이로그")).toBe("ko");
  });

  it("西里尔 → 俄语", () => {
    expect(detectScriptLanguage("Москва сегодня — новый выпуск")).toBe("ru");
  });

  it("阿拉伯字母 → 阿拉伯语", () => {
    expect(detectScriptLanguage("رحلة إلى دبي")).toBe("ar");
  });

  it("纯拉丁字母不猜——判不出就是判不出", () => {
    // en/es/fr/de 只能靠 n-gram 概率分，40 字的标题上基本是掷硬币，
    // 而猜错是静默的。宁可留空走 unknown。
    expect(detectScriptLanguage("How I built my startup in 30 days")).toBeNull();
    expect(detectScriptLanguage("Cómo construí mi empresa en 30 días")).toBeNull();
  });

  it("零星混入的非拉丁字符不足以定性", () => {
    // 英文标题里带一个中文地名，不该被判成中文。
    expect(detectScriptLanguage("Travel guide to 北京 for first timers")).toBeNull();
  });

  it("URL 里的拉丁字母不参与比例计算", () => {
    // 描述里塞满链接是常态。不剥 URL 的话，一段短日文描述会被链接稀释到阈值以下。
    expect(
      detectScriptLanguage("経営アシストサービス https://iqvia.decipherinc.com/survey/selfserve/5e0/g79c/230802")
    ).toBe("ja");
  });

  it("空 / 无文字内容 → null", () => {
    expect(detectScriptLanguage("")).toBeNull();
    expect(detectScriptLanguage("   \n  ")).toBeNull();
    expect(detectScriptLanguage("2026 #1 !!!")).toBeNull();
  });
});

describe("resolveVideoLanguage — 两级推导", () => {
  it("defaultAudioLanguage 优先于文本判定", () => {
    expect(
      resolveVideoLanguage({
        defaultAudioLanguage: "ja-JP",
        title: "北京旅游攻略",
      })
    ).toBe("ja");
  });

  it("defaultLanguage（元数据语言）不是有效输入字段，不影响判定——只看 defaultAudioLanguage", () => {
    // 回归测试：曾经的三级设计里 defaultLanguage 是二级兜底，已砍掉（见 detect-language.ts
    // 头部注释）。这里传一个 defaultLanguage 字段确认它被忽略，判定落到文本脚本判定。
    expect(
      resolveVideoLanguage({ defaultLanguage: "ko", title: "東京の夜を歩いてみた" } as never)
    ).toBe("ja");
  });

  it("Despacito 场景：西语歌但标题是英文写的，declared 声明缺失时不猜成英语，落到 unknown", () => {
    // 真实 bug：kJQP7kiw5Fk（Despacito）没有 defaultAudioLanguage，标题
    // "Luis Fonsi - Despacito ft. Daddy Yankee" 全拉丁字母。旧版 defaultLanguage
    // 兜底会读到 "en"（因为标题文本是英文写的），让 "语言 == 英语" 静默匹配到一首
    // 西语歌。砍掉那一级后，拉丁字母标题判不出，落到 unknown——不猜比猜错好。
    expect(
      resolveVideoLanguage({
        title: "Luis Fonsi - Despacito ft. Daddy Yankee",
        description: "Luis Fonsi - Despacito ft. Daddy Yankee (Official Video)",
      })
    ).toBe(LANGUAGE_UNKNOWN);
  });

  it("没有声明时才看文本", () => {
    expect(
      resolveVideoLanguage({
        title: "IQVIAジャパンによるクリニック経営アシストサービス",
        description: "院長が診療、やりたい事に専念できるよう経営やマネジメントを現場で伴走支援する",
      })
    ).toBe("ja");
  });

  it("标题判不出时，描述能补上信号", () => {
    expect(
      resolveVideoLanguage({
        title: "IQVIA 2026",
        description: "院長が診療、やりたい事に専念できるよう経営やマネジメントを現場で伴走支援するサービスです",
      })
    ).toBe("ja");
  });

  it("声明是 zxx（纯音乐）时不当语言用，继续往下推", () => {
    expect(resolveVideoLanguage({ defaultAudioLanguage: "zxx", title: "東京の夜を歩いてみた" })).toBe("ja");
  });

  it("两级全落空 → unknown 哨兵，绝不留空", () => {
    // 这是整个设计的关键：engine.ts 的 evaluateCondition 在进算子分支之前就
    // `actual == null → false`，所以留空会让 "语言 != 日语" 在判不出语言的视频上
    // 返回 false（视频被挡掉），与用户"只想排掉日语"的意图正好相反。
    expect(resolveVideoLanguage({ title: "How I built my startup in 30 days" })).toBe(LANGUAGE_UNKNOWN);
    expect(resolveVideoLanguage({})).toBe(LANGUAGE_UNKNOWN);
  });

  it("声明了短表以外的语言，原样透传", () => {
    // 下拉框约束的是"用户能选什么"，不是"payload 里能有什么"。
    // 一个葡萄牙语视频必须真的带 pt，"语言 != 日语" 才能正确放行它。
    expect(resolveVideoLanguage({ defaultAudioLanguage: "pt-BR" })).toBe("pt");
  });
});
