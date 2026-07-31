import { describe, it, expect } from "vitest";
import { conditionsPass } from "../../src/engine";
import { CONDITION_LOGIC_OR, CONDITION_LOGIC_AND } from "../../nodeTypeRegistry";

const PAYLOAD = { like_count: 100, view_count: 5, name: "alice" };
const TRUE_COND = { field: "like_count", operator: ">", value: "50" };
const FALSE_COND = { field: "like_count", operator: ">", value: "500" };
const BLANK_COND = { field: "", operator: "==", value: "" };

describe("conditionsPass — AND（默认，与本功能上线前逐字相同）", () => {
  it("0 条通过：没有过滤器 = 全部放行", () => {
    expect(conditionsPass([], CONDITION_LOGIC_AND, PAYLOAD)).toBe(true);
  });

  it("全是空行等同于 0 条，通过", () => {
    expect(conditionsPass([BLANK_COND, BLANK_COND], CONDITION_LOGIC_AND, PAYLOAD)).toBe(true);
  });

  it("一真一假 → false", () => {
    expect(conditionsPass([TRUE_COND, FALSE_COND], CONDITION_LOGIC_AND, PAYLOAD)).toBe(false);
  });

  it("全真 → true", () => {
    expect(conditionsPass([TRUE_COND, TRUE_COND], CONDITION_LOGIC_AND, PAYLOAD)).toBe(true);
  });

  it("空行不参与判定，不会把一条真条件拖下水", () => {
    expect(conditionsPass([TRUE_COND, BLANK_COND], CONDITION_LOGIC_AND, PAYLOAD)).toBe(true);
  });
});

describe("conditionsPass — OR", () => {
  it("0 条拦住：OR 的恒等元是 false", () => {
    expect(conditionsPass([], CONDITION_LOGIC_OR, PAYLOAD)).toBe(false);
  });

  it("全是空行等同于 0 条，拦住", () => {
    expect(conditionsPass([BLANK_COND, BLANK_COND], CONDITION_LOGIC_OR, PAYLOAD)).toBe(false);
  });

  it("一真一假 → true", () => {
    expect(conditionsPass([FALSE_COND, TRUE_COND], CONDITION_LOGIC_OR, PAYLOAD)).toBe(true);
  });

  it("全假 → false", () => {
    expect(conditionsPass([FALSE_COND, FALSE_COND], CONDITION_LOGIC_OR, PAYLOAD)).toBe(false);
  });

  it("空行不参与判定：一条真条件 + 一个空行仍然通过", () => {
    expect(conditionsPass([BLANK_COND, TRUE_COND], CONDITION_LOGIC_OR, PAYLOAD)).toBe(true);
  });
});

describe("conditionsPass — 畸形输入一律降级，绝不抛异常", () => {
  // 抛出去会逃出 executeContentActions：队列消息整条重试，这一批里已经执行过的 action
  // 全部重跑一遍（重复发帖 / 私信）。
  it.each([
    ["对象", { field: "x" } as unknown],
    ["字符串", "like_count > 50" as unknown],
    ["null", null as unknown],
    ["undefined", undefined as unknown],
    ["数字", 5 as unknown],
  ])("conditions 是%s时降级为 0 条（AND 通过）", (_label, bad) => {
    expect(conditionsPass(bad, CONDITION_LOGIC_AND, PAYLOAD)).toBe(true);
  });

  it("conditions 是对象时 OR 同样降级为 0 条（拦住）", () => {
    expect(conditionsPass({ field: "x" }, CONDITION_LOGIC_OR, PAYLOAD)).toBe(false);
  });

  it("数组里混进非对象元素时只跳过那一项", () => {
    expect(conditionsPass([null, TRUE_COND, "junk", 7], CONDITION_LOGIC_AND, PAYLOAD)).toBe(true);
    expect(conditionsPass([null, FALSE_COND, "junk"], CONDITION_LOGIC_OR, PAYLOAD)).toBe(false);
  });

  it.each([
    ["undefined（存量 graph 没有这个键）", undefined as unknown],
    ["'and'", "and" as unknown],
    ["大写 'OR'", "OR" as unknown],
    ["true", true as unknown],
    ["null", null as unknown],
    ["数字 1", 1 as unknown],
    ["对象", {} as unknown],
  ])("logic 是%s时走 AND", (_label, badLogic) => {
    // AND 下一真一假为 false；若误判成 OR 会是 true
    expect(conditionsPass([TRUE_COND, FALSE_COND], badLogic, PAYLOAD)).toBe(false);
    // AND 下 0 条为 true；若误判成 OR 会是 false
    expect(conditionsPass([], badLogic, PAYLOAD)).toBe(true);
  });
});

describe("conditionsPass — $user. 未解析引用", () => {
  // engine 的 resolveStringValue 对无法解析的 $user.x 引用会让该条件短路成 false
  // （见 engine.ts 的 missingUserRef）。OR 下它只该拉低自己那一条，不该拖垮整组。
  const USER_REF_COND = { field: "like_count", operator: ">", value: "$user.followers_count" };

  it("OR 下未解析的 user 引用不影响另一条真条件", () => {
    expect(conditionsPass([USER_REF_COND, TRUE_COND], CONDITION_LOGIC_OR, PAYLOAD)).toBe(true);
  });

  it("AND 下未解析的 user 引用使整组不通过", () => {
    expect(conditionsPass([USER_REF_COND, TRUE_COND], CONDITION_LOGIC_AND, PAYLOAD)).toBe(false);
  });
});
