// Both strategies must produce the same business result even if readiness is delivered twice.
// A stalled export must never turn into a completed report.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compare } from "../examples/recipes/export-wait/compare.ts";

test("a stable ready event wakes one run and both strategies produce the verified total", () => {
  const [later, probe] = compare(false, 2);
  assert.deepEqual([later.calls, probe.calls], [3, 1]);
  assert.deepEqual([later.products, probe.products], [["3,41"], ["3,41"]]);
  assert.equal(later.readyLagTicks, 0);
  assert.equal(probe.readyLagTicks, 0);
});

test("an export that never appears has no product and the probe never wakes the agent", () => {
  const [later, probe] = compare(false, null);
  assert.ok(later.calls > 0);
  assert.equal(probe.calls, 0);
  assert.deepEqual([later.products, probe.products], [[], []]);
});
