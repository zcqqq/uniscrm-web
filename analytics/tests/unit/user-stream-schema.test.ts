import { describe, it, expect } from "vitest";
import schema from "../../pipelines/user-stream-schema.json";
import {
  userValueColumns,
  r2FieldTypeForColumn,
  USER_R2_KEY_FIELDS,
} from "../../../metadata/columns";
import { PROPS } from "../../../metadata/props";

// The Iceberg `uniscrm.user` table's columns come from this stream schema. Rebuilding that
// table is expensive (rename-aside + sink/pipeline recreate), and a column no writer populates
// is dead weight — so the value columns must equal metadata/columns.ts's derivation from the
// PROPS registry (entity:"user" props minus the follow base columns, plus the documented
// verified_type exception), no more and no less. This is the machine enforcement of
// dataTypes.ts's entity contract on the user side: tagging a prop entity:["user"] without
// adding the schema field (and a tenant-DB migration) fails here; so does a schema field whose
// prop lost its entity tag. Sibling of event-stream-schema.test.ts / content-stream-schema.test.ts.
const schemaFieldNames = schema.fields.map((f) => f.name);
const schemaValueFields = schemaFieldNames.filter((n) => !(USER_R2_KEY_FIELDS as readonly string[]).includes(n));

describe("user-stream-schema.json", () => {
  it("carries exactly the derived user value columns — no dead columns, none missing", () => {
    expect([...schemaValueFields].sort()).toEqual([...userValueColumns()].sort());
  });

  it("keeps every key/audit column the pipeline writer always sends", () => {
    for (const field of USER_R2_KEY_FIELDS) expect(schemaFieldNames).toContain(field);
  });

  it("every entity:'user' prop is a real schema column (the entity contract, user side)", () => {
    const userProps = PROPS.filter((p) => p.entity?.includes("user"));
    for (const p of userProps) {
      expect(schemaFieldNames, `entity:["user"] prop ${p.propId} has no user-stream column`).toContain(p.propId);
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
