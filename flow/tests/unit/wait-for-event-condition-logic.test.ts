import { describe, it, expect } from "vitest";
import { executeFlow, conditionsPass, type FlowGraph } from "../../src/engine";
import { CONDITION_LOGIC_OR } from "../../nodeTypeRegistry";

function graphWithWait(waitData: Record<string, unknown>): FlowGraph {
  return {
    nodes: [
      { id: "t1", type: "xTrigger", data: { eventType: "follow.followed", channelId: "chan1", conditions: [] }, position: { x: 0, y: 0 } },
      { id: "w1", type: "waitForEvent", data: { eventType: "tweet.liked", duration: 3, unit: "days", ...waitData }, position: { x: 200, y: 0 } },
    ],
    edges: [{ id: "e1", source: "t1", target: "w1" }],
  };
}

describe("waitForEvent 把 conditionLogic 一起快照进 PendingWait", () => {
  const COND = [{ field: "like_count", operator: ">", value: "5" }];

  it("节点上是 'or' 时带进 pendingWait", () => {
    const r = executeFlow(graphWithWait({ conditions: COND, conditionLogic: CONDITION_LOGIC_OR }), "follow.followed", { channel_id: "chan1" });
    expect(r.pendingWaits).toHaveLength(1);
    expect(r.pendingWaits[0].conditionLogic).toBe("or");
  });

  it("节点上没有这个键时为空串（= AND），不是 undefined —— D1 列 NOT NULL", () => {
    const r = executeFlow(graphWithWait({ conditions: COND }), "follow.followed", { channel_id: "chan1" });
    expect(r.pendingWaits[0].conditionLogic).toBe("");
  });

  it("0 条条件时依然带上 logic —— OR + 0 条是有语义的（拦住），不能丢", () => {
    const r = executeFlow(graphWithWait({ conditions: [], conditionLogic: CONDITION_LOGIC_OR }), "follow.followed", { channel_id: "chan1" });
    expect(r.pendingWaits[0].conditionLogic).toBe("or");
  });

  it("畸形 logic 被规整成字符串，不会把非字符串塞进 D1 bind", () => {
    const r = executeFlow(graphWithWait({ conditions: COND, conditionLogic: { bad: 1 } }), "follow.followed", { channel_id: "chan1" });
    expect(typeof r.pendingWaits[0].conditionLogic).toBe("string");
  });
});

describe("resume 时按快照的 logic 判定", () => {
  // sweep 侧的行为等价于这一句：conditions 与 logic 都取自 flow_pending 的快照列。
  const PAYLOAD = { like_count: 100 };
  const HIT = { field: "like_count", operator: ">", value: "50" };
  const MISS = { field: "like_count", operator: ">", value: "500" };

  it("快照 logic 为 'or' 时一真一假放行", () => {
    expect(conditionsPass([HIT, MISS], "or", PAYLOAD)).toBe(true);
  });

  it("快照 logic 为空串时走 AND，一真一假不放行", () => {
    expect(conditionsPass([HIT, MISS], "", PAYLOAD)).toBe(false);
  });

  it("快照 logic 为 'or' 且条件列为空时不放行（等到超时走 no 分支）", () => {
    expect(conditionsPass([], "or", PAYLOAD)).toBe(false);
  });

  it("快照条件列是坏 JSON 时降级成 0 条，AND 下放行", () => {
    // sweep 里 JSON.parse 必须被 try 包住：抛出去会让整条队列消息重试。
    expect(conditionsPass([], "", PAYLOAD)).toBe(true);
  });
});
