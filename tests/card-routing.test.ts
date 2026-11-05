// A card that names one channel goes to that channel and no other; a card that names none goes to all of them.
// Failure modes: a card with a target is handed to another channel; that channel can claim it, report it sent, report it
// failed, or answer it as itself; the claim leaves a delivery fact behind; the routing is decided at delivery time
// instead of at creation, so a rule change moves cards that were already made; the routing is lost when the projection
// is rebuilt from the log; two events on the same rule and subject with different targets are merged into one run.
import assert from "node:assert/strict";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

setup("card-routing");

const { ingest } = await import("../host/runtime.ts");
const { claimNext, finish, started, answer, nextCard, delivered, failed, getView } = await import("../host/runtime.ts");
const { AuthError, NotFound, InputError } = await import("../kernel/errors.ts");
const { all, one, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};
const note = (id: string, subject = "#1") => ({ id, type: "feedback.new", subject });
const card = (id: number) => one<any>("SELECT * FROM cards WHERE id = ?", [id])!;

/** A rule that sends its cards to one channel only. */
const targeted = { name: "定向", channels: ["chat"] };

/** The rule set under test: one rule that may pick a channel per task. */
const rulesWith = (channels?: string[]) => ({
  timezone: "Asia/Shanghai",
  sources: { app: { name: "应用" } },
  agents: { a1: { name: "甲", worker: "w1", use: "claude", model: "m1" } },
  channels: { chat: { name: "聊天", answerers: ["me"] }, plain: { name: "文字", links: true } },
  rules: [
    {
      name: "意见",
      when: { source: "app", types: ["feedback.*"] },
      to: "a1",
      cwd: "~/x",
      skill: "s",
      prompt: "按手册做。",
      group: "notes",
      parallel: 3,
      ...(channels ? { channels } : {}),
    },
  ],
  elsewhere: [],
});

const { execute } = await import("../host/runtime.ts");

/** Puts a rule set in place, the way a rules.json edit would. */
function useRules(channels?: string[]) {
  const parsed = structuredClone(rulesWith(channels)) as any;
  execute("rules", [parsed]);
}

/** Runs a rule to the point where it asks a question. */
function asked(id: string, now = at(0)) {
  ingest("app", note(id), now);
  const job = claimNext("w1", `c${id}`)!;
  started(job.run, job.token, { session: `s-${id}` }, now);
  finish(
    job.run,
    job.token,
    { outcome: "done", summary: "等你决定", ask: [{ title: "要不要", text: "说明", options: ["要", "不要"] }] },
    now,
  );
  return one<{ id: number }>("SELECT id FROM cards WHERE title = '要不要' ORDER BY id DESC")!.id;
}

test("a card that names a channel goes to that channel alone", () => {
  clean();
  useRules(["chat"]);
  const id = asked("t1");
  assert.equal(card(id).target_channel, "chat", "the card says where it goes");
  const mine = nextCard("chat", at(1))!;
  assert.equal(mine.id, id, "the target channel gets it");
  assert.equal(nextCard("plain", at(1)), null, "no other channel does");
});

test("a card that names no channel goes to all of them, like before", () => {
  clean();
  useRules();
  const id = asked("t2");
  assert.equal(card(id).target_channel, null, "no rule names a channel, so it is not directed");
  assert.equal(nextCard("chat", at(1))!.id, id);
  assert.equal(nextCard("plain", at(1))!.id, id, "the other channel has its own copy");
});

test("a channel that isn't the target cannot claim it, and cannot leave a delivery fact behind", () => {
  clean();
  useRules(["chat"]);
  const id = asked("t3");
  assert.equal(nextCard("plain", at(1)), null, "it never gets the card");
  assert.throws(() => delivered("plain", id, 1, "p_1", at(1)), AuthError, "it cannot claim to have sent it");
  assert.throws(() => failed("plain", id, 1, "假装失败", at(1)), AuthError, "it never held the card either");
  assert.equal(all("SELECT card_id FROM deliveries").length, 0, "no delivery fact was written");
});

test("a target cannot confirm delivery before claiming the card", () => {
  clean();
  useRules(["chat"]);
  const id = asked("unclaimed");
  const before = getView().seq;
  assert.throws(() => delivered("chat", id, 1, "forged", at(1)), AuthError);
  assert.equal(getView().seq, before);
  assert.equal(all("SELECT card_id FROM deliveries").length, 0);
});

test("a target cannot confirm a future or invalid card version", () => {
  clean();
  useRules(["chat"]);
  const id = asked("bad-version");
  nextCard("chat", at(1));
  const before = getView().seq;
  for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 999]) {
    assert.throws(() => delivered("chat", id, version, "ref", at(1)), InputError);
    assert.equal(getView().seq, before);
  }
  delivered("chat", id, 1, "ref", at(1));
  answer(id, { choice: 0 }, at(2));
  delivered("chat", id, 1, "ref", at(2));
  assert.equal(nextCard("chat", at(3))!.version, 2);
});

test("a channel that isn't the target cannot answer as itself", async () => {
  clean();
  useRules(["chat"]);
  const id = asked("t4");
  // The target channel holds the card.
  nextCard("chat", at(1));
  delivered("chat", id, 1, "om_1", at(1));
  // The other channel managed to leave a delivery fact behind, so the ref check alone would let it through:
  // the target check is what has to stop it.
  const { db } = await import("../host/runtime.ts");
  db.prepare("INSERT INTO projections VALUES ('deliveries', ?, ?)").run(
    `${id}:plain`,
    JSON.stringify({ card_id: id, channel: "plain", version: 1, ref: "om_1", tries: 1 }),
  );
  assert.throws(
    () => answer(id, { choice: 0, by: "me", channel: "plain", ref: "om_1" }, at(2)),
    AuthError,
    "another channel's identity does not answer it",
  );
  assert.equal(card(id).state, "open");
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 0, "nothing was woken");
});

test("the routing is written on the card, so a rule change does not move cards that were already made", () => {
  clean();
  useRules(["chat"]);
  const id = asked("t5");
  useRules(["plain"]);
  assert.equal(card(id).target_channel, "chat", "the card keeps the routing it was made with");
  assert.equal(nextCard("chat", at(1))!.id, id);
  assert.equal(nextCard("plain", at(1)), null, "the new rule does not take the old card");
});

test("the routing survives the projection being rebuilt from the log", async () => {
  clean();
  useRules(["chat"]);
  const id = asked("t6");
  assert.equal(card(id).target_channel, "chat");
  const { rebuild } = await import("../kernel/store.ts");
  const { db } = await import("../host/runtime.ts");
  rebuild(db);
  assert.equal(card(id).target_channel, "chat", "the fact log carries it, so the rebuild keeps it");
  assert.equal(nextCard("plain", at(1)), null, "and it still goes to one channel only");
});

test("an event with unknown fields such as target is rejected and cannot forge routing", () => {
  clean();
  useRules(["chat", "plain"]);
  assert.throws(
    () => ingest("app", { ...note("m1"), target: "chat" } as any, at(0)),
    InputError,
    "events cannot carry target to influence routing",
  );
});

test("two queued runs on the same rule and subject with different target_channels are segregated", () => {
  clean();
  useRules(["chat", "plain"]);
  const before = all("SELECT id FROM runs").length;
  // Rule default takes the first channel: "chat"
  ingest("app", note("m1"), at(0));
  // Ingest on another rule or direct enqueue with target_channel isolation
  // Note: per §7.3/7.4, task-specific target override shape at trusted ingress is not yet frozen,
  // but kernel run segregation by target_channel must strictly isolate runs.
  const r1 = one<any>("SELECT id, rule, lane, target_channel FROM runs ORDER BY id DESC")!;
  assert.equal(r1.target_channel, "chat");

  // If another run is queued for the same rule and lane but with a different target_channel (e.g. "plain"),
  // they must remain independent runs and not merge.
  execute("rules", [structuredClone(rulesWith(["plain", "chat"]))]);
  ingest("app", note("m2"), at(0));
  const runs = all<any>("SELECT id, rule, lane, target_channel FROM runs ORDER BY id ASC");
  assert.equal(runs.length - before, 2, "runs with different targets remain distinct");
  assert.deepEqual(
    runs.map((r) => r.target_channel),
    ["chat", "plain"],
  );
});

test("an omitted target inherits the rule default; a stated null means every channel", () => {
  clean();
  useRules(["chat"]);
  const omitted = execute("createCard", [{ key: "implicit", kind: "ask", title: "implicit", rule: "意见" }]);
  assert.equal(card(omitted.card).target_channel, "chat", "silence takes the rule's channel");
  const stated = execute("createCard", [
    { key: "null", kind: "ask", title: "null", rule: "意见", target_channel: null },
  ]);
  assert.equal(card(stated.card).target_channel, null, "asking for every channel gets every channel");
  const broadcast = nextCard("plain", at(1));
  assert.equal(broadcast?.id, stated.card, "the channel the rule does not name still gets the stated card");
  assert.equal(nextCard("chat", at(2))?.id, omitted.card, "the rule's channel gets the card that named it");
});

test("explicit card routing rejects unknown and disallowed channels without writing facts", () => {
  clean();
  useRules(["chat"]);
  const before = getView().seq;
  for (const target of ["plain", "nowhere", "", 17]) {
    assert.throws(
      () =>
        execute("createCard", [
          { key: `invalid-${target}`, kind: "ask", title: "x", rule: "意见", target_channel: target },
        ]),
      InputError,
    );
    assert.equal(getView().seq, before);
  }
});

test("a rule that names a channel the rules file does not know is refused", async () => {
  clean();
  const { parseRules } = await import("../protocol/rules.ts");
  assert.throws(
    () => parseRules(JSON.stringify(rulesWith(["nowhere"])), 0, "UTC"),
    /没有这个通道/,
    "a rule may not name a channel that does not exist",
  );
});

test("a run cannot see or resolve open cards from another target_channel", () => {
  clean();
  useRules(["chat"]);
  const c1 = asked("iso1"); // card created with target_channel = 'chat'

  // Change rule default channel to 'plain'
  execute("rules", [structuredClone(rulesWith(["plain"]))]);
  ingest("app", note("iso2"), at(1));
  const job = claimNext("w1", "c-iso2", at(1))!;
  started(job.run, job.token, { session: "s-iso2" }, at(1));

  // job.context.open must not contain c1 because run target_channel is 'plain' and c1 is 'chat'
  assert.equal(
    job.context.open.some((c: any) => c.card === c1),
    false,
    "open card of chat is not in scope for plain run",
  );

  // Attempting to resolve c1 from this plain run must be rejected
  const receipt = finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "越界尝试",
      resolve: [{ card: c1, reason: "试图关闭不同通道的卡片" }],
    },
    at(2),
  );
  assert.deepEqual(
    receipt.rejected.map((r: any) => ({ card: r.card, reason: r.reason })),
    [{ card: c1, reason: "不在本轮核对范围" }],
  );
  assert.equal(card(c1).state, "open", "c1 remains open");
});

test("jobOf isolates context answers, timers, waiting, and decided by target_channel with legacy broadcast compatibility", async () => {
  clean();
  useRules(["chat"]);
  const now = at(0);

  // Directly insert historical / mixed target cards and timers to verify jobOf isolation
  const { db } = await import("../host/runtime.ts");
  const insertProj = db.prepare("INSERT INTO projections VALUES ('cards', ?, ?)");
  const insertTimer = db.prepare("INSERT INTO projections VALUES ('timers', ?, ?)");

  // Rule '意见', parallel: 3, lane: 'L1'
  const rule = "意见";
  const lane = "L1";

  // Run R_chat (target_channel: 'chat')
  // Run R_plain (target_channel: 'plain')
  // Run R_legacy (target_channel: null)
  const eventChat = 101;
  const eventPlain = 102;
  const eventLegacy = 103;

  // Let's create decided cards:
  // c_chat: target_channel = 'chat'
  // c_plain: target_channel = 'plain'
  // c_legacy1: target_channel = null
  // c_legacy2: no target_channel field
  const cardChat = {
    id: 201,
    rule,
    lane,
    grp: "notes",
    state: "decided",
    target_channel: "chat",
    options: "[]",
    choice: null,
    answer: "ans_chat",
    decided_at: at(1),
  };
  const cardPlain = {
    id: 202,
    rule,
    lane,
    grp: "notes",
    state: "decided",
    target_channel: "plain",
    options: "[]",
    choice: null,
    answer: "ans_plain",
    decided_at: at(1),
  };
  const cardNull = {
    id: 203,
    rule,
    lane,
    grp: "notes",
    state: "decided",
    target_channel: null,
    options: "[]",
    choice: null,
    answer: "ans_null",
    decided_at: at(1),
  };
  const cardLegacy = {
    id: 204,
    rule,
    lane,
    grp: "notes",
    state: "decided",
    options: "[]",
    choice: null,
    answer: "ans_legacy",
    decided_at: at(1),
  };

  insertProj.run("201", JSON.stringify(cardChat));
  insertProj.run("202", JSON.stringify(cardPlain));
  insertProj.run("203", JSON.stringify(cardNull));
  insertProj.run("204", JSON.stringify(cardLegacy));

  // Timers:
  // t_chat (waiting), t_plain (waiting), t_legacy (waiting)
  const timerChat = {
    id: 301,
    rule,
    lane,
    key: "k_chat",
    event_id: null,
    target_channel: "chat",
    about: "about chat",
    at: new Date(at(10)).toISOString(),
  };
  const timerPlain = {
    id: 302,
    rule,
    lane,
    key: "k_plain",
    event_id: null,
    target_channel: "plain",
    about: "about plain",
    at: new Date(at(10)).toISOString(),
  };
  const timerLegacy = {
    id: 303,
    rule,
    lane,
    key: "k_legacy",
    event_id: null,
    about: "about legacy",
    at: new Date(at(10)).toISOString(),
  };

  insertTimer.run("301", JSON.stringify(timerChat));
  insertTimer.run("302", JSON.stringify(timerPlain));
  insertTimer.run("303", JSON.stringify(timerLegacy));

  // Answers (cards with answer_event = eventChat/eventPlain/eventLegacy)
  const ansChat = {
    id: 205,
    rule,
    lane,
    grp: "notes",
    state: "decided",
    target_channel: "chat",
    options: "[]",
    choice: null,
    answer: "ok",
    answer_event: eventChat,
    decided_at: at(1),
  };
  const ansPlain = {
    id: 206,
    rule,
    lane,
    grp: "notes",
    state: "decided",
    target_channel: "plain",
    options: "[]",
    choice: null,
    answer: "ok",
    answer_event: eventPlain,
    decided_at: at(1),
  };
  const ansLegacy = {
    id: 207,
    rule,
    lane,
    grp: "notes",
    state: "decided",
    options: "[]",
    choice: null,
    answer: "ok",
    answer_event: eventLegacy,
    decided_at: at(1),
  };

  insertProj.run("205", JSON.stringify(ansChat));
  insertProj.run("206", JSON.stringify(ansPlain));
  insertProj.run("207", JSON.stringify(ansLegacy));

  const insert = db.prepare("INSERT INTO projections VALUES (?, ?, ?)");
  for (const eventId of [eventChat, eventPlain, eventLegacy]) {
    insert.run(
      "events",
      String(eventId),
      JSON.stringify({ id: eventId, key: `e${eventId}`, source: "app", type: "card.answered" }),
    );
    for (const runId of [501, 502, 503]) {
      insert.run("run_events", `${runId}:${eventId}`, JSON.stringify({ run_id: runId, event_id: eventId }));
    }
    insertTimer.run(
      String(eventId + 300),
      JSON.stringify({
        id: eventId + 300,
        rule,
        lane,
        key: `due-${eventId}`,
        event_id: eventId,
        ...(eventId === eventChat
          ? { target_channel: "chat" }
          : eventId === eventPlain
            ? { target_channel: "plain" }
            : {}),
        at: new Date(at(10)).toISOString(),
        about: "due",
      }),
    );
  }

  // Check jobOf via kernel query
  const { jobOf } = await import("../kernel/query.ts");
  const { getView } = await import("../host/runtime.ts");
  const view = getView();

  const runChat = {
    id: 501,
    rule,
    lane,
    grp: "notes",
    agent: "a1",
    rules_version: 1,
    attempts: 0,
    target_channel: "chat",
  };
  const runPlain = {
    id: 502,
    rule,
    lane,
    grp: "notes",
    agent: "a1",
    rules_version: 1,
    attempts: 0,
    target_channel: "plain",
  };
  const runLegacy = {
    id: 503,
    rule,
    lane,
    grp: "notes",
    agent: "a1",
    rules_version: 1,
    attempts: 0,
    target_channel: null,
  };

  const fakeEnv = { secret: "test-secret", publicUrl: "http://localhost" } as any;

  const jobChat = jobOf(view, runChat as any, fakeEnv);
  const jobPlain = jobOf(view, runPlain as any, fakeEnv);
  const jobLegacy = jobOf(view, runLegacy as any, fakeEnv);

  // Verify decided isolation
  const decidedChatIds = jobChat.context.decided.map((c: any) => c.card);
  const decidedPlainIds = jobPlain.context.decided.map((c: any) => c.card);
  const decidedLegacyIds = jobLegacy.context.decided.map((c: any) => c.card);

  assert.deepEqual(
    jobChat.context.answers.map((a: any) => a.card),
    [205],
  );
  assert.deepEqual(
    jobPlain.context.answers.map((a: any) => a.card),
    [206],
  );
  assert.deepEqual(
    jobLegacy.context.answers.map((a: any) => a.card),
    [207],
  );
  assert.deepEqual(
    jobChat.context.timers.map((t: any) => t.key),
    ["due-101"],
  );
  assert.deepEqual(
    jobPlain.context.timers.map((t: any) => t.key),
    ["due-102"],
  );
  assert.deepEqual(
    jobLegacy.context.timers.map((t: any) => t.key),
    ["due-103"],
  );
  assert.deepEqual(decidedChatIds, [201]);
  assert.deepEqual(decidedPlainIds, [202]);
  assert.deepEqual(decidedLegacyIds.sort(), [203, 204]);

  // Verify waiting timers isolation
  const waitingChatKeys = jobChat.context.waiting.map((t: any) => t.key);
  const waitingPlainKeys = jobPlain.context.waiting.map((t: any) => t.key);
  const waitingLegacyKeys = jobLegacy.context.waiting.map((t: any) => t.key);

  assert.deepEqual(waitingChatKeys, ["k_chat"]);
  assert.deepEqual(waitingPlainKeys, ["k_plain"]);
  assert.deepEqual(waitingLegacyKeys, ["k_legacy"]);
});
