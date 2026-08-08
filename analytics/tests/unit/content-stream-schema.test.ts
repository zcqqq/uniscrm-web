import { describe, it, expect } from "vitest";
import schema from "../../pipelines/content-stream-schema.json";
import {
  contentR2ValueColumns,
  r2FieldTypeForColumn,
  CONTENT_R2_KEY_FIELDS,
} from "../../../metadata/columns";
import { PROPS } from "../../../metadata/props";

// The Iceberg `uniscrm.content` table's columns come from this stream schema. Same rule as the
// user/event siblings: the value columns must equal metadata/columns.ts's derivation from the
// PROPS registry (entity:"content" props via contentColumnMap — incl. the content_url ->
// source_url rename — plus the non-prop extras summary/source_updated_at/impression_count),
// no more and no less. This is the machine enforcement of dataTypes.ts's entity contract on
// the content side. Historical motivation: processed_video_url / video_transcript /
// translated_subtitle_text carried entity:["content"] for months while existing in NO store —
// three dead, always-empty columns in the Content list UI. They are flow-payload-only now
// (metadata/props.ts) and this test keeps that class of drift from returning.
const schemaFieldNames = schema.fields.map((f) => f.name);
const schemaValueFields = schemaFieldNames.filter((n) => !(CONTENT_R2_KEY_FIELDS as readonly string[]).includes(n));

describe("content-stream-schema.json", () => {
  it("carries exactly the derived content value columns — no dead columns, none missing", () => {
    expect([...schemaValueFields].sort()).toEqual([...contentR2ValueColumns()].sort());
  });

  it("keeps every key/audit column the pipeline writer always sends", () => {
    for (const field of CONTENT_R2_KEY_FIELDS) expect(schemaFieldNames).toContain(field);
  });

  it("every entity:'content' prop is a real schema column (the entity contract, content side)", () => {
    const contentProps = PROPS.filter((p) => p.entity?.includes("content"));
    for (const p of contentProps) {
      const column = p.propId === "content_url" ? "source_url" : p.propId;
      expect(schemaFieldNames, `entity:["content"] prop ${p.propId} has no content-stream column`).toContain(column);
    }
  });

  it("the flow-payload-only video props stay out of entity and out of the schema", () => {
    for (const propId of ["processed_video_url", "video_transcript", "translated_subtitle_text"]) {
      const def = PROPS.find((p) => p.propId === propId);
      expect(def, propId).toBeDefined();
      expect(def!.entity ?? [], `${propId} must not carry entity (flow-payload-only)`).toHaveLength(0);
      expect(schemaFieldNames, propId).not.toContain(propId);
    }
  });

  it("types each value column consistently with its PROPS dataType", () => {
    for (const column of schemaValueFields) {
      const field = schema.fields.find((f) => f.name === column)!;
      expect(field.type, column).toBe(r2FieldTypeForColumn(column));
    }
  });

  it("marks every value column optional — a writer only knows the columns its caller resolved", () => {
    for (const column of schemaValueFields) {
      expect(schema.fields.find((f) => f.name === column)!.required, column).toBe(false);
    }
  });
});
