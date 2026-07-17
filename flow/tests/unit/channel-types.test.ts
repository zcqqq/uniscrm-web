import { describe, it, expect } from "vitest";
import { CHANNEL_TYPES } from "../../frontend/config/trigger-fields";
import { EventMetadata_X } from "../../../metadata/x";

describe("CHANNEL_TYPES", () => {
  it("gives the X channel type an actions list mirroring EventMetadata_X's flowType:'action' entries", () => {
    const x = CHANNEL_TYPES.find((ct) => ct.channelType === "X")!;
    const expectedActionTypes = EventMetadata_X.filter((m) => m.flowType === "action").map((m) => m.eventType);
    expect(x.actions.map((a) => a.eventType).sort()).toEqual(expectedActionTypes.sort());
  });

  it("keeps the X channel's trigger events list unchanged (flowType:'trigger' entries)", () => {
    const x = CHANNEL_TYPES.find((ct) => ct.channelType === "X")!;
    const expectedTriggerTypes = EventMetadata_X.filter((m) => m.flowType === "trigger").map((m) => m.eventType);
    expect(x.events.map((e) => e.eventType).sort()).toEqual(expectedTriggerTypes.sort());
  });
});
