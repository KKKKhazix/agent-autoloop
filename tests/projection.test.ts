// Failure modes: a draft mutates its base; filtered reads miss changed/new rows or retain deleted rows;
// restart replays all history, reuses a deleted ID, or trusts an incompatible projection;
// history size forces a point lookup to scan or populate a whole JavaScript table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { empty, evolve, rows, snapshot, type Fact } from "../kernel/evolve.ts";
import { commit, openView } from "../kernel/store.ts";

const fact = (seq: number, changes: Fact["changes"]): Fact => ({ version: 1, seq, at: seq, type: "fixture", changes });
test("a draft overlays filtered reads without changing the base", () => {
  const base = evolve(empty(), [
    fact(1, [
      { table: "cards", key: "1", row: { id: 1, state: "open" } },
      { table: "cards", key: "2", row: { id: 2, state: "closed" } },
    ]),
  ]);
  const before = snapshot(base);
  const draft = base.fork();
  draft.set("cards", "1", { id: 1, state: "closed" });
  draft.set("cards", "2", { id: 2, state: "open" });
  draft.set("cards", "3", { id: 3, state: "open" });
  assert.deepEqual(
    rows(draft, "cards", { state: "open" }).map((r) => r.id),
    [2, 3],
  );
  draft.set("cards", "2", null);
  assert.deepEqual(
    rows(draft, "cards", { state: "open" }).map((r) => r.id),
    [3],
  );
  assert.deepEqual(snapshot(base), before);
  base.close();
});

test("restart reuses projections and preserves deleted ID high water", () => {
  const db = new DatabaseSync(":memory:");
  let view = openView(db, "format-a");
  view = commit(db, view, () => [fact(1, [{ table: "timers", key: "9", row: { id: 9 } }])]);
  view = commit(db, view, () => [
    fact(2, [
      { table: "timers", key: "9", row: null },
      { table: "events", key: "1", row: { id: 1 } },
    ]),
  ]);
  db.exec(
    "CREATE TEMP TRIGGER no_reset BEFORE DELETE ON projections BEGIN SELECT RAISE(ABORT,'unexpected replay'); END",
  );
  const reopened = openView(db, "format-a");
  assert.equal(reopened.seq, 2);
  assert.equal(reopened.next.timers, 9);
  assert.deepEqual(snapshot(reopened), snapshot(view));
  db.exec("DROP TRIGGER no_reset");
  const expected = snapshot(reopened);
  assert.deepEqual(snapshot(openView(db, "format-b")), expected);
  db.close();
});
