import { describe, it, expect } from "vitest";
import schema from "../../pipelines/event-stream-schema.json";
import { EventMetadata_X } from "../../../metadata/x";
import { PROPS } from "../../../metadata/props";

// The Iceberg `uniscrm.event` table's columns come from this stream schema. Rebuilding
// that table is expensive (rename-aside + sink/pipeline recreate), and a column that no
// event type can populate is dead weight the analytics UI never offers — so the prop
// columns must equal the union of every channel's EventMetadata[].eventProps, no more
// and no less. Two earlier drifts motivated this test: the file was once generated from
// PROPS.filter(isInsight) (17 dead columns, incl. content-only props like `height`), and
// `tweet_count` outlived its rename to `post_count` in the sibling user schema.
const IDENTITY_FIELDS = ["tenant_id", "id", "user_id", "channel_id", "event_type", "event_time", "created_at"];

// Only metadata/x.ts declares eventProps today; tiktok/youtube/x-byok define User/Content
// metadata only. Add their event metadata arrays here when they gain event support.
const EVENT_METADATA = [EventMetadata_X];

const metadataPropIds = [
  ...new Set(EVENT_METADATA.flatMap((mod) => mod.flatMap((e) => e.eventProps.map((p) => p.propId)))),
].sort();

const schemaFieldNames = schema.fields.map((f) => f.name);
const schemaPropIds = schemaFieldNames.filter((n) => !IDENTITY_FIELDS.includes(n)).sort();

describe("event-stream-schema.json", () => {
  it("carries exactly the props declared by event metadata — no dead columns, none missing", () => {
    expect(schemaPropIds).toEqual(metadataPropIds);
  });

  it("keeps every identity/time column the pipeline writer always sends", () => {
    for (const field of IDENTITY_FIELDS) expect(schemaFieldNames).toContain(field);
  });

  it("types each prop column consistently with its PROPS dataType", () => {
    for (const propId of schemaPropIds) {
      const def = PROPS.find((p) => p.propId === propId);
      expect(def, `${propId} missing from PROPS`).toBeDefined();
      const field = schema.fields.find((f) => f.name === propId)!;
      expect(field.type, `${propId} (${def!.dataType})`).toBe(def!.dataType === "INT" ? "int32" : "string");
    }
  });

  it("marks every prop column optional — an event only carries the props its own type declares", () => {
    for (const propId of schemaPropIds) {
      expect(schema.fields.find((f) => f.name === propId)!.required, propId).toBe(false);
    }
  });
});
