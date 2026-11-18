// Failure mode: the fact schema's per-table row constraints (events/run_events/cards) look enforced but a
// validator without allOf/if-then support silently passes anything — a run_event row without run_id, or an
// events row without the keys the workbench reads back, must be rejected by checkSchema itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSchema } from "../protocol/schema.ts";

const runEvent = { run_id: 7, event_id: 41 };
const eventsRow = { id: 41, source: "workbench", key: "wb-rev", type: "workbench.auto" };

test("fact rows satisfy their per-table constraints", () => {
  assert.deepEqual(
    checkSchema("fact", {
      version: 1,
      seq: 1,
      at: 1,
      type: "receipt",
      changes: [{ table: "run_events", key: "7:41", row: runEvent }],
    }),
    [],
  );
  assert.deepEqual(
    checkSchema("fact", {
      version: 1,
      seq: 2,
      at: 1,
      type: "receipt",
      changes: [{ table: "events", key: "wb-rev", row: eventsRow }],
    }),
    [],
  );
  assert.deepEqual(
    checkSchema("fact", {
      version: 1,
      seq: 3,
      at: 1,
      type: "receipt",
      changes: [{ table: "cards", key: "9", row: { id: 9, state: "open", version: 1, run_id: null } }],
    }),
    [],
  );
  // Null rows (deletions) stay legal in every table.
  assert.deepEqual(
    checkSchema("fact", {
      version: 1,
      seq: 4,
      at: 1,
      type: "receipt",
      changes: [{ table: "events", key: "wb-rev", row: null }],
    }),
    [],
  );
});

test("rows missing a consumed key are rejected, and the branch really applies per table", () => {
  // events without id — the workbench's accepted-event recovery key.
  assert.ok(
    checkSchema("fact", {
      version: 1,
      seq: 5,
      at: 1,
      type: "receipt",
      changes: [{ table: "events", key: "wb-rev", row: { source: "workbench", key: "wb-rev" } }],
    }).length > 0,
  );
  // run_events missing run_id.
  assert.ok(
    checkSchema("fact", {
      version: 1,
      seq: 6,
      at: 1,
      type: "receipt",
      changes: [{ table: "run_events", key: "7:41", row: { event_id: 41 } }],
    }).length > 0,
  );
  // cards without version.
  assert.ok(
    checkSchema("fact", {
      version: 1,
      seq: 7,
      at: 1,
      type: "receipt",
      changes: [{ table: "cards", key: "9", row: { id: 9, state: "open" } }],
    }).length > 0,
  );
  // The same shapes are clean under a table whose branch does not constrain those keys:
  // proves the if/then dispatches on the table name rather than validating unconditionally.
  const unconstrained = { table: "runs", key: "7", row: { event_id: 41 } };
  assert.deepEqual(
    checkSchema("fact", {
      version: 1,
      seq: 8,
      at: 1,
      type: "receipt",
      changes: [unconstrained as never],
    }),
    [],
  );
});
