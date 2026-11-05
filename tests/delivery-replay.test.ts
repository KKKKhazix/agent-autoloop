// Broadcast cards keep the receipt rule they have always had: a channel may report that it showed a card without
// having asked for it, because receipts already in flight when a rule gained a target channel must still land.
// Failure modes: the compatibility opening is widened to directed cards; a replay of an old receipt takes the
// version or the message id back, so the card is shown again; a replay writes a second delivery for one channel;
// a receipt for a card no channel was ever given is reported as taken.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("delivery-replay");

const { ingest, claimNext, started, finish, answer, resolve, nextCard, delivered, createCard, getView } =
  await import("../host/runtime.ts");
const { AuthError, NotFound } = await import("../kernel/errors.ts");
const { all, one, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};
const note = (n: number) => ({ id: `feedback:${n}`, type: "feedback.new", subject: `#${n}` });
const card = (id: number) => one<any>("SELECT * FROM cards WHERE id = ?", [id])!;
const delivery = (id: number, channel: string) =>
  one<any>("SELECT * FROM deliveries WHERE card_id = ? AND channel = ?", [id, channel]);
const deliveryCount = (id: number) =>
  one<{ n: number }>("SELECT count(*) AS n FROM deliveries WHERE card_id = ?", [id])!.n;

/** A run that ends by asking: its rule names no channel, so the card is one for every channel. */
function askedBroadcast(n: number, now = at(0)) {
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

/** A card made for one channel only. */
const askedDirected = (now = at(0)) =>
  createCard(
    {
      key: "directed",
      kind: "ask",
      title: "只问一处",
      text: "",
      options: ["甲", "乙"],
      target_channel: "chat",
      source: "app",
      grp: "notes",
    },
    now,
  ).card;

test("a channel may report showing a broadcast card it never asked for", () => {
  clean();
  const id = askedBroadcast(1);
  assert.equal(card(id).target_channel, null);
  delivered("chat", id, 1, "om_legacy", at(1));
  const reported = delivery(id, "chat");
  assert.deepEqual([reported.version, reported.ref, reported.error], [1, "om_legacy", null]);
  assert.equal(deliveryCount(id), 1);
});

test("the same report for a card made for one channel is refused and writes nothing", () => {
  clean();
  const id = askedDirected();
  const before = getView().seq;
  assert.throws(() => delivered("chat", id, 1, "om_legacy", at(1)), AuthError);
  assert.throws(() => delivered("plain", id, 1, "p_legacy", at(1)), AuthError);
  assert.equal(getView().seq, before, "a refused report writes no fact");
  assert.equal(deliveryCount(id), 0);
});

test("reporting the same broadcast card twice leaves one delivery and does not send it again", () => {
  clean();
  const id = askedBroadcast(2);
  delivered("chat", id, 1, "om_1", at(1));
  delivered("chat", id, 1, "om_1", at(2));
  assert.equal(deliveryCount(id), 1);
  assert.deepEqual(
    [delivery(id, "chat").version, delivery(id, "chat").ref],
    [1, "om_1"],
    "the report is the same report",
  );
  assert.equal(nextCard("chat", at(4)), null, "the card is already out");
  const other = nextCard("plain", at(4))!;
  assert.equal(other.id, id, "another channel still has its own copy");
});

test("an older report replayed after a newer one takes neither the version nor the message id back", () => {
  clean();
  const id = askedBroadcast(3);
  delivered("chat", id, 1, "om_1", at(1));
  answer(id, { choice: 0, by: "me", channel: "chat", ref: "om_1" }, at(2));
  const update = nextCard("chat", at(3))!;
  assert.deepEqual([update.id, update.version, update.ref], [id, 2, "om_1"], "the update is the same message");
  delivered("chat", id, update.version, "om_1", at(4));
  // A delayed copy of the first report arrives: it says less than what is known, so it changes nothing.
  delivered("chat", id, 1, "om_1", at(5));
  assert.deepEqual(
    [delivery(id, "chat").version, delivery(id, "chat").ref],
    [2, "om_1"],
    "the report never moves backwards",
  );
  assert.equal(nextCard("chat", at(6)), null);
});

// The message an update belongs to is the one the channel first named: a channel that posts the update as a new
// message and answers on it is told the message is not the one that was sent. Legacy behaviour, unchanged here.
test("an update reported under a new message id is answered on the id the channel first named", () => {
  clean();
  const id = askedBroadcast(5);
  delivered("chat", id, 1, "om_1", at(1));
  answer(id, { choice: 0, by: "me", channel: "chat", ref: "om_1" }, at(2));
  delivered("chat", id, nextCard("chat", at(3))!.version, "om_2", at(4));
  assert.equal(delivery(id, "chat").ref, "om_1", "the first id is kept");
  assert.throws(() => answer(id, { choice: 1, by: "me", channel: "chat", ref: "om_2" }, at(5)), AuthError);
});

test("a report for a card that does not exist is refused", () => {
  clean();
  assert.throws(() => delivered("chat", 999, 1, "om_1", at(1)), NotFound);
  assert.throws(() => resolve(999, "没有这张卡", "owner", at(1)), NotFound);
  assert.equal(one<{ n: number }>("SELECT count(*) AS n FROM deliveries")!.n, 0);
});

// Not a behaviour worth keeping, but the one broadcast cards still have: the version they name is not bounded by the
// card's own. A report naming a version past the card's silences that channel for good, because a card is sent again
// only while the delivery it knows is older than the card. Directed cards refuse this; broadcast cards do not.
test("known gap: a broadcast report naming a future version is taken, and silences that channel", () => {
  clean();
  const id = askedBroadcast(4);
  delivered("plain", id, 1, "p_1", at(1));
  delivered("chat", id, 9, "om_future", at(1));
  assert.equal(delivery(id, "chat").version, 9);
  answer(id, { choice: 0, by: "me" }, at(2));
  assert.equal(nextCard("chat", at(3)), null, "the channel is never offered the answer it made");
  assert.equal(nextCard("plain", at(3))!.version, 2, "other channels are unaffected");
});
