import { describe, it, expect } from "vitest";
import { conditionSummary, nextConditionLogic } from "../../frontend/lib/condition-logic";
import { CONDITION_LOGIC_OR, CONDITION_LOGIC_AND } from "../../nodeTypeRegistry";

describe("conditionSummary", () => {
  it("单数不加 s", () => {
    expect(conditionSummary(1, CONDITION_LOGIC_AND)).toBe("1 condition");
  });

  it("复数加 s", () => {
    expect(conditionSummary(2, CONDITION_LOGIC_AND)).toBe("2 conditions");
  });

  it("OR 且 ≥2 条时标出 · any", () => {
    expect(conditionSummary(2, CONDITION_LOGIC_OR)).toBe("2 conditions · any");
    expect(conditionSummary(5, CONDITION_LOGIC_OR)).toBe("5 conditions · any");
  });

  it("OR 但只有 1 条时不标 —— 此时 AND/OR 结果完全相同，标出来只是噪音", () => {
    expect(conditionSummary(1, CONDITION_LOGIC_OR)).toBe("1 condition");
  });

  it("logic 缺省 / 畸形一律不标", () => {
    expect(conditionSummary(3, undefined)).toBe("3 conditions");
    expect(conditionSummary(3, "OR")).toBe("3 conditions");
    expect(conditionSummary(3, true)).toBe("3 conditions");
  });
});

describe("nextConditionLogic", () => {
  it("点已生效的那一段返回 null —— 不该产生一次没有实质改动的 Unsaved", () => {
    // 否则用户点一下当前高亮项就被标脏，按 Back 时被问"要不要保存"，而他什么都没改。
    expect(nextConditionLogic(CONDITION_LOGIC_OR, CONDITION_LOGIC_OR)).toBeNull();
    expect(nextConditionLogic(CONDITION_LOGIC_AND, CONDITION_LOGIC_AND)).toBeNull();
  });

  it("缺省态（存量 graph 没这个键）视同 AND，点 AND 返回 null", () => {
    expect(nextConditionLogic(undefined, CONDITION_LOGIC_AND)).toBeNull();
  });

  it("缺省态点 OR 返回 'or'", () => {
    expect(nextConditionLogic(undefined, CONDITION_LOGIC_OR)).toBe("or");
  });

  it("OR 点 AND 返回 'and'", () => {
    expect(nextConditionLogic(CONDITION_LOGIC_OR, CONDITION_LOGIC_AND)).toBe("and");
  });

  it("畸形 current 视同 AND", () => {
    expect(nextConditionLogic(true, CONDITION_LOGIC_AND)).toBeNull();
    expect(nextConditionLogic("OR", CONDITION_LOGIC_OR)).toBe("or");
  });
});
