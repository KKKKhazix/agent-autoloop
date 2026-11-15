// Cards for a named person. Failure cases: rules.json registers people, or lets a rule name them, in a way that can't work
// (an unknown person or channel, two people on one address, someone no channel can reach) and the hub starts anyway; a
// receipt names someone its rule doesn't allow, or someone not registered, and the card is made; asking two people the same
// thing under one key reaches only the first; a card for someone reaches a channel that doesn't send by recipient, or one
// where they have no address, or the owner's channels the rule lists, or comes with a link anyone holding it could answer
// with; a channel doesn't learn who the card is for and where; someone else on the channel answers it, the owner answers it
// with their key or through a link, or the answer is kept under the address rather than the person; the owner can't take
// it back, nor a later round of the same matter; the job doesn't say whom the rule may name, so a worker can't check a
// receipt before handing it in; the prompt of a rule that names no one changes; a question a task elsewhere asks names
// someone; the owner's state doesn't say whom a card is for, and `status` tells the owner to answer a card only someone
// else can.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { at, setup } from "./helpers.ts";
import { promptFor, readMessage, resultFrom } from "../worker/contract.ts";
import { isAsk, parseResult } from "../protocol/validate.ts";
import { checkSchema } from "../protocol/schema.ts";
import { parseRules, RulesError } from "../protocol/rules.ts";
import { render as renderStatus } from "../cli/status.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-people-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const base = {
  timezone: "Asia/Shanghai",
  sources: { app: { name: "应用" } },
  agents: { a1: { name: "甲", worker: "w1", use: "claude" } },
  channels: {
    chat: { name: "聊天", answerers: ["me"] },
    team: { name: "团队", people: true, links: true },
    mail: { name: "邮件", people: true },
  },
  people: {
    alice: { name: "前端 A", at: { team: "ou_a", chat: "ou_a_chat" }, workers: ["w9"] },
    bob: { name: "后端 B", at: { team: "ou_b" } },
  },
  rules: [
    {
      name: "指派",
      when: { source: "app", types: ["assign.*"] },
      to: "a1",
      cwd: "~/x",
      prompt: "派活。",
      parallel: 3,
      people: ["alice"],
      channels: ["chat"],
    },
    { name: "全员", when: { source: "app", types: ["all.*"] }, to: "a1", cwd: "~/x", prompt: "派活。", people: ["*"] },
    { name: "不点名", when: { source: "app", types: ["plain.*"] }, to: "a1", cwd: "~/x", prompt: "做事。" },
  ],
  elsewhere: [
    { name: "每周", source: "app", to: "a1", cron: "0 6 * * 0", where: "别处", cwd: "~/x", prompt: "接着做。" },
  ],
};
const rulesFile = join(dir, "rules.json");
writeFileSync(rulesFile, JSON.stringify(base));
setup("people", rulesFile);

const hub = await import("./hub.ts");
const { addKey, answer, claimNext, delivered, environment, finish, getView, ingest, nextCard, resolve } = hub;
const { serve } = await import("../host/http.ts");
const { credential } = await import("../kernel/credentials.ts");
const { AuthError } = await import("../kernel/errors.ts");
const { all, one } = await import("./storage.ts");

let n = 0;
/** A run of `rule` that hands in `receipt`; what it was given, what it made and what was turned down. */
function receipt(rule: string, receiptBody: object, now = at(0)) {
  const type = { 指派: "assign.new", 全员: "all.new", 不点名: "plain.new" }[rule]!;
  ingest("app", { id: `e${++n}`, type, subject: `#${n}` }, now);
  const job = claimNext("w1", `c${n}`, now)!;
  assert.equal(job.rule.name, rule);
  const { rejected } = finish(job.run, job.token, { outcome: "done", ...receiptBody }, now);
  const cards = all<any>("SELECT * FROM cards WHERE run_id = ? ORDER BY id", [job.run]);
  return { job, cards, rejected };
}
const ask = (extra: object = {}) => ({ title: "接这个任务吗", text: "登录页改版", options: ["接", "退回"], ...extra });
/** Everything each channel is handed now, as it would see it, reported delivered so it isn't handed again. */
function drain(channel: string, now = at(0)) {
  const seen = [];
  for (let card; (card = nextCard(channel, now));) {
    seen.push(card);
    delivered(channel, card.id, card.version, `${channel}-${card.id}`, now);
  }
  return seen;
}
const stored = (id: number) => one<any>('SELECT state, choice, by, "to" FROM cards WHERE id = ?', [id])!;

test("rules.json: people, the channels that send by recipient and what each rule may name are checked", () => {
  const check = (change: (rules: any) => void) => {
    const rules = structuredClone(base);
    change(rules);
    try {
      parseRules(JSON.stringify(rules), at(0), "UTC");
      return [];
    } catch (error) {
      if (error instanceof RulesError) return error.issues;
      throw error;
    }
  };
  assert.deepEqual(
    check(() => {}),
    [],
  );
  const bad: [string, (rules: any) => void][] = [
    ["不是已登记的人", (r) => (r.rules[0].people = ["carol"])],
    ["不是已登记的通道", (r) => (r.people.bob.at = { team: "ou_b", fax: "1" })],
    ["地址", (r) => (r.people.bob.at.team = "ou_a")],
    ["送不出去", (r) => (r.people.bob.at = { chat: "ou_b" })],
    ["编号", (r) => (r.people["Bob"] = { name: "B", at: { team: "x" } })],
    ["people", (r) => (r.channels.team.people = "yes")],
    ["不认识的字段", (r) => (r.people.bob.mail = "b@x")],
  ];
  for (const [said, change] of bad) {
    const issues = check(change);
    assert.ok(
      issues.some((issue) => issue.includes(said)),
      `${said}: ${issues.join(" / ")}`,
    );
  }
});

test("a receipt can only name someone registered whom its rule allows; the rest is turned down and makes no card", () => {
  const named = receipt("指派", { ask: [ask({ to: "alice" }), ask({ to: "bob", key: "b" })] });
  assert.deepEqual(
    named.cards.map((card) => card.to),
    ["alice"],
  );
  assert.equal(named.rejected.length, 1);
  assert.match(named.rejected[0].reason, /bob/);
  const unknown = receipt("全员", { notice: [{ title: "知道一下", text: "改版了", to: "carol" }] });
  assert.deepEqual([unknown.cards.length, unknown.rejected.length], [0, 1]);
  const nobody = receipt("不点名", { ask: [ask({ to: "alice" })], notice: [{ title: "知道", text: "了" }] });
  assert.deepEqual([nobody.cards.length, nobody.rejected.length], [1, 1], "the notice for the owner still goes");
  assert.equal(nobody.cards[0].to, null);
});

test("a failed run's notice naming someone its rule doesn't allow is turned down too", () => {
  ingest("app", { id: `e${++n}`, type: "plain.new", subject: `#${n}` }, at(0));
  const job = claimNext("w1", `c${n}`, at(0))!;
  const notice = [{ title: "卡住了", text: "等网络", to: "alice" }];
  const { rejected } = finish(job.run, job.token, { outcome: "failed", error: "断网", notice }, at(0));
  assert.equal(all("SELECT id FROM cards WHERE run_id = ?", [job.run]).length, 0);
  assert.equal(rejected.length, 1);
  hub.cancel(job.run, at(0));
});

test("the same key asked of two people makes a card for each, and once for each while it's open", () => {
  const first = receipt("全员", { ask: [ask({ key: "lease", to: "alice" }), ask({ key: "lease", to: "bob" })] });
  assert.deepEqual(
    first.cards.map((card) => card.to),
    ["alice", "bob"],
  );
  const owner = receipt("全员", { ask: [ask({ key: "lease" })] });
  assert.equal(owner.cards.length, 1, "nor does the owner's card under that key stand in for them");
  const again = receipt("全员", { ask: [ask({ key: "lease", to: "alice" }), ask({ key: "lease" })] });
  assert.equal(again.cards.length, 0, "asked again while each is still open, nothing new is made");
});

test("a later round of the matter still sees a card for someone and can take it back", () => {
  const asked = receipt("全员", { ask: [ask({ to: "bob", key: "withdraw" })] }).cards[0].id;
  ingest("app", { id: `e${++n}`, type: "all.new", subject: `#${n}` }, at(1));
  const job = claimNext("w1", `c${n}`, at(1))!;
  assert.ok(job.context.open.some((open) => open.card === asked));
  const { rejected } = finish(
    job.run,
    job.token,
    { outcome: "done", resolve: [{ card: asked, reason: "改派了" }] },
    at(1),
  );
  assert.deepEqual(rejected, []);
  assert.equal(stored(asked).state, "closed");
});

test("a card for someone reaches only channels that send by recipient where they have an address, with no link", () => {
  drain("chat");
  drain("team");
  drain("mail");
  const { cards } = receipt("指派", { ask: [ask({ to: "alice", key: "reach" })] });
  const [id] = cards.map((card) => card.id);
  assert.deepEqual(
    drain("chat").map((card) => card.id),
    [],
    "not the owner's channel, though the rule lists it and alice has an address there",
  );
  assert.deepEqual(
    drain("mail").map((card) => card.id),
    [],
    "not a channel where she has no address",
  );
  const [sent] = drain("team");
  assert.equal(sent.id, id);
  assert.deepEqual(sent.to, { id: "alice", name: "前端 A", address: "ou_a" });
  assert.equal(sent.link, null, "a link would let whoever holds it answer for her");
  const plain = receipt("全员", { ask: [ask({ key: "for-owner" })] }).cards[0].id;
  const [owners] = drain("team");
  assert.equal(owners.id, plain);
  assert.equal(owners.to, undefined, "a card for the owner is as it was");
  assert.ok(owners.link, "and keeps its link");
});

test("only the person a card is for answers it, on the message sent to them, and the answer is kept as theirs", () => {
  drain("team");
  const { cards } = receipt("指派", { ask: [ask({ to: "alice", key: "answer" })] });
  const id = cards[0].id;
  drain("team");
  const on = { channel: "team", ref: `team-${id}` };
  assert.throws(() => answer(id, { choice: 0, by: "ou_b", ...on }), AuthError, "bob can't answer for her");
  assert.throws(() => answer(id, { choice: 0, by: "me", channel: "chat", ref: `team-${id}` }), AuthError);
  assert.throws(() => answer(id, { choice: 0, by: "ou_a", channel: "team", ref: "other" }), AuthError);
  assert.equal(answer(id, { choice: 0, by: "ou_a", ...on }, at(0)).changed, true);
  assert.deepEqual([stored(id).state, stored(id).by], ["decided", "alice"]);
  const job = claimNext("w1", `after-${id}`, at(1))!;
  assert.deepEqual(
    job.context.answers.map((given) => [given.card, given.by]),
    [[id, "alice"]],
  );
  finish(job.run, job.token, { outcome: "done" }, at(1));
});

test("the owner's key can't answer a card for someone, but can still take it back", () => {
  const { cards } = receipt("指派", { ask: [ask({ to: "alice", key: "owner" })] });
  const id = cards[0].id;
  assert.throws(() => answer(id, { choice: 0, by: "本人" }), AuthError);
  assert.equal(stored(id).state, "open");
  assert.equal(resolve(id, "不派了", "本人"), true);
  assert.equal(stored(id).state, "closed");
});

const keys = { owner: addKey("owner", "owner") };
const server = serve(0, "127.0.0.1");
let url = "";
before(async () => {
  await new Promise((done) => server.once("listening", done));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test("a card for someone has no page at its link: it neither shows nor answers", async () => {
  const { cards } = receipt("指派", { ask: [ask({ to: "alice", key: "link" })] });
  const card = getView().get("cards", cards[0].id)!;
  const path = `/c/${credential(environment, "card", card.id, card.created_at)}`;
  const shown = await fetch(url + path);
  assert.equal(shown.status, 404);
  assert.ok(!(await shown.text()).includes("登录页改版"));
  const posted = await fetch(url + path, { method: "POST", body: "choice=0", redirect: "manual" });
  assert.equal(posted.status, 404);
  assert.equal(stored(card.id).state, "open");
});

test("the owner's state says whom a card is for", async () => {
  const { cards } = receipt("指派", { ask: [ask({ to: "alice", key: "state" })] });
  const response = await fetch(`${url}/v1/state`, { headers: { authorization: `Bearer ${keys.owner}` } });
  const state = await response.json();
  const shown = state.cards.find((card: any) => card.id === cards[0].id);
  assert.deepEqual(shown.to, { id: "alice", name: "前端 A" });
  assert.equal(state.cards.find((card: any) => !card.to)?.to, undefined);
});

test("status says whom a card is for, and how the owner takes it back rather than how to answer it", async () => {
  const theirs = receipt("指派", { ask: [ask({ to: "alice", key: "status" })] }).cards[0].id;
  const owners = receipt("不点名", { ask: [ask({ key: "status" })] }).cards[0].id;
  const response = await fetch(`${url}/v1/state`, { headers: { authorization: `Bearer ${keys.owner}` } });
  const text = renderStatus(await response.json(), { color: false, columns: 100 });
  assert.match(text, /发给：前端 A/);
  assert.ok(text.includes(`agent-autoloop resolve ${theirs} `));
  assert.ok(!text.includes(`agent-autoloop answer ${theirs} `), "the owner's key can't answer it");
  assert.ok(text.includes(`agent-autoloop answer ${owners} `));
});

test("the job says whom its rule may name, and a worker turns back a receipt naming anyone else", () => {
  const named = receipt("指派", {}).job;
  assert.deepEqual(named.rule.people, [{ id: "alice", name: "前端 A" }]);
  const everyone = receipt("全员", {}).job;
  assert.deepEqual(everyone.rule.people, [
    { id: "alice", name: "前端 A" },
    { id: "bob", name: "后端 B" },
  ]);
  const nobody = receipt("不点名", {}).job;
  assert.equal("people" in nobody.rule, false);

  const message = (to: string) =>
    readMessage(`派好了\n\`\`\`agent-autoloop\n${JSON.stringify({ ask: [ask({ to })] })}\n\`\`\``);
  const people = named.rule.people!.map((person) => person.id);
  assert.equal(resultFrom(message("alice"), {}, people).problem, undefined);
  assert.match(resultFrom(message("bob"), {}, people).problem!, /bob/);
  assert.match(resultFrom(message("alice"), {}, []).problem!, /to/);

  const prompt = promptFor(named, "/tmp/context.json");
  assert.match(prompt, /alice（前端 A）/);
  assert.ok(!promptFor(nobody, "/tmp/context.json").includes('"to"'), "a rule naming no one is told nothing new");
});

test("a receipt's to is a person's id, a task elsewhere can't name anyone, and the schema agrees", () => {
  for (const to of ["alice", "m-fe-1"]) {
    const result = { outcome: "done", ask: [ask({ to })], notice: [{ title: "知道", text: "了", to }] };
    assert.deepEqual(parseResult(result), result);
    assert.deepEqual(checkSchema("result", result), []);
  }
  for (const to of ["", "Alice", "ou a", 7, null]) {
    const result = { outcome: "done", ask: [ask({ to })] };
    assert.throws(() => parseResult(result), /ask/);
    assert.ok(checkSchema("result", result).length);
  }
  assert.equal(isAsk(ask({ to: "alice" })), false);
  assert.equal(isAsk(ask()), true);
});
