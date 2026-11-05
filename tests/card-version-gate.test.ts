// An answer that names the version it saw is only accepted if the card is still at that version.
// Failure modes: a stale answer is taken as if it were current, so a decision made on an old screen still counts;
// a stale answer is answered with "nothing changed", which the caller reads as "it went through"; a version that is
// not a whole positive number is taken as no version at all; a refused answer still writes a fact, a delivery, an
// event, or wakes the thread that asked; two answers at the same version both count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("card-version-gate");

const { ingest } = await import("../host/runtime.ts");
const { claimNext, finish, started, answer, resolve, nextCard, delivered, getView } =
  await import("../host/runtime.ts");
const { Conflict, InputError, NotFound, AuthError } = await import("../kernel/errors.ts");
const { all, one, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};
const note = (n: number) => ({ id: `feedback:${n}`, type: "feedback.new", subject: `#${n}` });
const card = (id: number) => one<any>("SELECT * FROM cards WHERE id = ?", [id])!;

/** A run that ends by asking, so there is a card to answer. */
function asked(n: number, now = at(0)) {
  ingest("app", note(n), now);
  const job = claimNext("w1", `c${n}`)!;
  started(job.run, job.token, { session: `s-${n}` }, now);
  finish(
    job.run,
    job.token,
    { outcome: "done", summary: "等你决定", ask: [{ title: "要不要", text: "说明", options: ["要", "不要"] }] },
    now,
  );
  return one<{ id: number }>("SELECT id FROM cards WHERE title = '要不要' ORDER BY id DESC")!.id;
}

test("an answer that names the version it saw is taken, and the card moves on a version", () => {
  clean();
  const id = asked(1);
  const before = card(id).version;
  assert.equal(answer(id, { choice: 0, by: "me", expectedVersion: before }, at(1)).changed, true);
  assert.equal(card(id).state, "decided");
  assert.equal(card(id).version, before + 1, "the card says what it is now");
});

test("an answer that names an old version is refused, and refuses it out loud", () => {
  clean();
  const id = asked(2);
  const seen = card(id).version;
  // The card moves on before the answer arrives: the person acted on an old screen.
  resolve(id, "问题自己好了", "owner", at(1));
  assert.throws(() => answer(id, { choice: 0, by: "me", expectedVersion: seen }, at(2)), Conflict);
});

test("an answer that names an old version of an open card is refused too", () => {
  clean();
  const id = asked(3);
  const seen = card(id).version;
  answer(id, { choice: 0, by: "me" }, at(1));
  // The card is decided now; the same old version must not be counted again.
  assert.throws(() => answer(id, { choice: 1, by: "me", expectedVersion: seen }, at(2)), Conflict);
});

test("a refused answer changes nothing at all", () => {
  clean();
  const id = asked(4);
  const seen = card(id).version;
  const before = getView().seq;
  assert.throws(() => answer(id, { choice: 0, by: "me", expectedVersion: seen + 5 }, at(1)), Conflict);
  assert.equal(getView().seq, before, "no fact was written");
  assert.equal(card(id).state, "open", "the card is still open");
  assert.equal(card(id).version, seen, "and still at the version it was");
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 0, "no event was written");
  assert.equal(all("SELECT card_id FROM deliveries").length, 0, "no delivery fact was written");
  assert.equal(all("SELECT id FROM runs WHERE state IN ('queued', 'claimed')").length, 0, "no thread was woken");
});

test("a missing card, a wrong channel and a stale version are told apart in that order", () => {
  clean();
  const id = asked(9);
  const seen = card(id).version;
  // No such card: a stale version too still reads as a missing card.
  assert.throws(() => answer(9999, { choice: 0, by: "me", expectedVersion: seen + 5 }, at(1)), NotFound);
  // A channel that was never handed the card: refused as that channel before any version is looked at.
  assert.throws(
    () => answer(id, { choice: 0, by: "me", channel: "chat", ref: "om_1", expectedVersion: seen + 5 }, at(1)),
    AuthError,
  );
  // The card has already moved on, and the answer names the version it now shows: nothing to do, not an error.
  assert.equal(answer(id, { choice: 0, by: "me" }, at(2)).changed, true);
  assert.deepEqual(answer(id, { choice: 1, by: "me", expectedVersion: card(id).version }, at(3)), {
    changed: false,
    state: "decided",
  });
});

test("a version that is not a whole positive number is refused as a mistake, not taken as no version", () => {
  clean();
  const id = asked(5);
  const seen = card(id).version;
  for (const bad of [0, -1, 1.5, "1", null]) {
    assert.throws(
      () => answer(id, { choice: 0, by: "me", expectedVersion: bad as any }, at(1)),
      InputError,
      `${JSON.stringify(bad)} is not a version`,
    );
  }
  assert.equal(card(id).state, "open", "the card is untouched");
  assert.equal(card(id).version, seen);
});

test("an answer without a version keeps the old behaviour", () => {
  clean();
  const id = asked(6);
  assert.equal(answer(id, { choice: 0, by: "me" }, at(1)).changed, true);
  assert.equal(answer(id, { choice: 1, by: "me" }, at(2)).changed, false, "the second one counts for nothing");
  assert.equal(card(id).choice, 0);
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 1);
});

test("two answers at the same version: one counts, the other is told the version moved", () => {
  clean();
  const id = asked(7);
  const seen = card(id).version;
  assert.equal(answer(id, { choice: 0, by: "me", expectedVersion: seen }, at(1)).changed, true);
  assert.throws(() => answer(id, { choice: 1, by: "me", expectedVersion: seen }, at(2)), Conflict);
  assert.equal(card(id).choice, 0, "the first one is the one that counts");
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 1, "one event, not two");
});

test("a channel's answer can name the version too", () => {
  clean();
  const id = asked(8);
  const given = nextCard("chat", at(1))!;
  delivered("chat", id, given.version, "om_1", at(1));
  assert.equal(
    answer(id, { choice: 0, by: "me", channel: "chat", ref: "om_1", expectedVersion: given.version }, at(2)).changed,
    true,
  );
  assert.equal(card(id).state, "decided");
});
