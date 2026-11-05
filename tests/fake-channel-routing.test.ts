// Integrated isolated tests for three-channel in-memory fake adapters (chat/bark/weixin)
// Verifies:
// 1. Directed card goes ONLY to target channel (nextCard returns card for target, null for other channels).
// 2. Answering brings card into unique final state (decided/closed) and wakes originating run with choice/text.
// 3. Race condition with identical expectedVersion results in 409 Conflict for the losing attempt.
// 4. Undirected cards or target-only cards do NOT leak/broadcast to unintended channels.
// 5. Fake adapters send requests only to the local loopback hub.
import assert from "node:assert/strict";
import { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

// Prepare isolated environment
setup("fake-channel-adapters");

const { serve } = await import("../host/http.ts");
const { addKey, execute } = await import("../host/runtime.ts");
const { hubClient } = await import("../protocol/client.ts");
const { all, one, run } = await import("./storage.ts");
import type { Card } from "../host/channels.ts";

// Register 3 fake channels in rules: chat, bark, weixin
const threeChannelRules = {
  timezone: "Asia/Shanghai",
  sources: { app: { name: "应用" } },
  agents: {
    a1: { name: "甲", worker: "w1", use: "command", command: ["echo", "ok"] },
    a2: { name: "乙", worker: "w1", use: "command", command: ["echo", "ok"] },
  },
  channels: {
    chat: { name: "即时通讯", answerers: ["operator-chat"] },
    bark: { name: "Bark通知", answerers: ["operator-bark"], links: true },
    weixin: { name: "企业微信", answerers: ["operator-weixin"] },
  },
  rules: [
    {
      name: "工单流-chat",
      when: { source: "app", types: ["ticket.chat.*"] },
      to: "a1",
      cwd: "/tmp",
      prompt: "处理工单",
      group: "g-chat",
      channels: ["chat"],
    },
    {
      name: "告警流-bark",
      when: { source: "app", types: ["alert.bark.*"] },
      to: "a1",
      cwd: "/tmp",
      prompt: "处理告警",
      group: "g-bark",
      channels: ["bark"],
    },
    {
      name: "审批流-weixin",
      when: { source: "app", types: ["approval.weixin.*"] },
      to: "a2",
      cwd: "/tmp",
      prompt: "审批流转",
      group: "g-weixin",
      channels: ["weixin"],
    },
  ],
  elsewhere: [],
};

// Apply rules
execute("rules", [structuredClone(threeChannelRules)]);

// Create API keys for the actors
const keys = {
  app: addKey("source", "app"),
  w1: addKey("worker", "w1"),
  chat: addKey("channel", "chat"),
  bark: addKey("channel", "bark"),
  weixin: addKey("channel", "weixin"),
  owner: addKey("owner", "owner"),
};

// Start real local HTTP server on loopback
const server: Server = serve(0, "127.0.0.1", { commit: "fake-channels-test" });
await new Promise((resolve) => server.once("listening", resolve));
const port = (server.address() as AddressInfo).port;
const hubUrl = `http://127.0.0.1:${port}`;

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};

// Fake In-Memory Adapters
// Track received cards, delivery acknowledgements, and answers sent back
type FakeAdapterState = {
  received: Card[];
  deliveredRefs: Map<number, string>;
  answerLog: Array<{ cardId: number; choice?: number; text?: string; status: number; error?: string }>;
  receivedCount: number;
};

function createInMemoryAdapter(channelName: string, answererName: string) {
  const state: FakeAdapterState = {
    received: [],
    deliveredRefs: new Map(),
    answerLog: [],
    receivedCount: 0,
  };

  const client = hubClient(hubUrl, keys[channelName as keyof typeof keys]);

  async function runner({ hub, signal }: { hub: typeof client; signal: AbortSignal }) {
    while (!signal.aborted) {
      let card: Card | null = null;
      try {
        const res = await hub.nextCard(0);
        card = res?.card ?? null;
      } catch (err) {
        if (signal.aborted) break;
        throw err;
      }
      if (!card) {
        break;
      }
      state.received.push(card);
      state.receivedCount++;
      const ref = `${channelName}_ref_${card.id}_v${card.version}`;
      await hub.delivered(card.id, card.version, ref);
      state.deliveredRefs.set(card.id, ref);
    }
  }

  async function submitAnswer(cardId: number, options: { choice?: number; text?: string; expectedVersion?: number }) {
    const ref = state.deliveredRefs.get(cardId);
    try {
      const res = await client.answer(cardId, {
        ...options,
        by: answererName,
        ref,
      });
      state.answerLog.push({ cardId, choice: options.choice, text: options.text, status: 200 });
      return { status: 200, data: res };
    } catch (err: any) {
      const status = err.status ?? 500;
      state.answerLog.push({ cardId, choice: options.choice, text: options.text, status, error: err.message });
      return { status, error: err.message };
    }
  }

  return { state, client, runner, submitAnswer };
}

test("directed cards only reach the target fake channel", async () => {
  clean();
  const chatAdapter = createInMemoryAdapter("chat", "operator-chat");
  const barkAdapter = createInMemoryAdapter("bark", "operator-bark");
  const weixinAdapter = createInMemoryAdapter("weixin", "operator-weixin");

  // Ingest an event targeting bark
  const { ingest, claimNext, started, finish } = await import("../host/runtime.ts");
  const now = Date.now();
  ingest("app", { id: "ev-bark-1", type: "alert.bark.disk", subject: "node-1" }, now);

  // Worker w1 claims the job and asks question
  const job = claimNext("w1", "claim-bark-1", now)!;
  assert.ok(job, "worker gets the job");
  started(job.run, job.token, { session: "sess-bark-1" }, now);
  finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "磁盘已满，是否清理？",
      ask: [{ title: "清理确认", text: "空间达95%", options: ["清理", "忽略"], key: "clean-opt" }],
    },
    now,
  );

  const cardRow = one<any>("SELECT * FROM cards WHERE title = '清理确认'");
  assert.ok(cardRow, "card created");
  assert.equal(cardRow.target_channel, "bark", "card has explicit target_channel bark");

  // Poll with all 3 adapters
  const stopCtrl = new AbortController();
  await chatAdapter.runner({ hub: chatAdapter.client, signal: stopCtrl.signal });
  await weixinAdapter.runner({ hub: weixinAdapter.client, signal: stopCtrl.signal });
  await barkAdapter.runner({ hub: barkAdapter.client, signal: stopCtrl.signal });

  // Verify targeting & non-broadcast
  assert.equal(chatAdapter.state.received.length, 0, "chat must NOT receive bark targeted card");
  assert.equal(weixinAdapter.state.received.length, 0, "weixin must NOT receive bark targeted card");
  assert.equal(barkAdapter.state.received.length, 1, "bark must receive the card");
  assert.equal(barkAdapter.state.received[0].id, cardRow.id);
  assert.equal(barkAdapter.state.deliveredRefs.has(cardRow.id), true);
});

test("answering card transitions to unique decided state and correctly unblocks the originating agent loop", async () => {
  clean();
  const weixinAdapter = createInMemoryAdapter("weixin", "operator-weixin");

  const { ingest, claimNext, started, finish } = await import("../host/runtime.ts");
  const now = Date.now();
  ingest("app", { id: "ev-wx-1", type: "approval.weixin.purchase", subject: "req-99" }, now);

  const job1 = claimNext("w1", "claim-wx-1", now)!;
  started(job1.run, job1.token, { session: "sess-wx-1" }, now);
  finish(
    job1.run,
    job1.token,
    {
      outcome: "done",
      summary: "采购审批等待中",
      ask: [{ title: "采购审批单", text: "金额 5000 元", options: ["同意", "驳回"], key: "approve-key" }],
    },
    now,
  );

  const cardRow = one<any>("SELECT * FROM cards WHERE title = '采购审批单'");
  assert.equal(cardRow.state, "open");

  // Weixin channel claims & delivers
  const stopCtrl = new AbortController();
  await weixinAdapter.runner({ hub: weixinAdapter.client, signal: stopCtrl.signal });
  assert.equal(weixinAdapter.state.received.length, 1);

  // Weixin channel submits answer
  const answerRes = await weixinAdapter.submitAnswer(cardRow.id, {
    choice: 0,
    expectedVersion: 1,
  });
  assert.equal(answerRes.status, 200);
  assert.equal((answerRes.data as any).changed, true);
  assert.equal((answerRes.data as any).state, "decided");

  // Check persisted card state
  const updatedCard = one<any>("SELECT * FROM cards WHERE id = ?", [cardRow.id]);
  assert.equal(updatedCard.state, "decided", "state is uniquely decided");
  assert.equal(updatedCard.choice, 0);
  assert.equal(updatedCard.by, "operator-weixin");
  assert.equal(updatedCard.version, 2, "version incremented to 2");

  // Verify worker receives the answer in context
  const job2 = claimNext("w1", "claim-wx-followup", Date.now() + 1000)!;
  assert.ok(job2, "follow-up job queued upon card decision");
  assert.equal(job2.context.answers.length, 1);
  assert.equal(job2.context.answers[0].choice, 0);
  assert.equal(job2.context.answers[0].card, cardRow.id);
});

test("concurrency race with identical expectedVersion: first wins, second receives 409 Conflict", async () => {
  clean();
  const chatAdapter = createInMemoryAdapter("chat", "operator-chat");

  const { ingest, claimNext, started, finish } = await import("../host/runtime.ts");
  const now = Date.now();
  ingest("app", { id: "ev-chat-conflict", type: "ticket.chat.triage", subject: "ticket-12" }, now);

  const job = claimNext("w1", "claim-chat-1", now)!;
  started(job.run, job.token, { session: "sess-chat-1" }, now);
  finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "是否转专员",
      ask: [{ title: "转派工单", text: "工单类别咨询", options: ["确认转派", "自行处理"], key: "dispatch-key" }],
    },
    now,
  );

  const cardRow = one<any>("SELECT * FROM cards WHERE title = '转派工单'");
  assert.equal(cardRow.version, 1);

  const stopCtrl = new AbortController();
  await chatAdapter.runner({ hub: chatAdapter.client, signal: stopCtrl.signal });
  assert.equal(chatAdapter.state.received.length, 1);

  // Fire two concurrent answer requests with the same expectedVersion = 1
  const [res1, res2] = await Promise.all([
    chatAdapter.submitAnswer(cardRow.id, { choice: 0, expectedVersion: 1 }),
    chatAdapter.submitAnswer(cardRow.id, { choice: 1, expectedVersion: 1 }),
  ]);

  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [200, 409], "one must succeed with 200, other must fail with 409 Conflict");

  // Verify card state holds the winning choice and version 2
  const cardAfter = one<any>("SELECT * FROM cards WHERE id = ?", [cardRow.id]);
  assert.equal(cardAfter.version, 2);
  assert.equal(cardAfter.state, "decided");
  const winningChoice = res1.status === 200 ? 0 : 1;
  assert.equal(cardAfter.choice, winningChoice);

  // The refused attempt wrote nothing: one answered event, one waking run, no second decision.
  assert.equal(all("SELECT id FROM events WHERE type = 'card.answered'").length, 1, "one answer, one event");
  assert.equal(all("SELECT id FROM runs WHERE state = 'queued'").length, 1, "one waking run, not two");
  assert.equal(all("SELECT id FROM cards WHERE state = 'decided'").length, 1);
});

test("fake channels isolate directed cards and receive broadcast cards", async () => {
  clean();
  const chatAdapter = createInMemoryAdapter("chat", "operator-chat");
  const barkAdapter = createInMemoryAdapter("bark", "operator-bark");
  const weixinAdapter = createInMemoryAdapter("weixin", "operator-weixin");

  // 1. Create a directed card to weixin
  const madeWeixin = execute("createCard", [
    {
      key: "wx-manual",
      kind: "ask",
      title: "微信卡片",
      options: ["确定"],
      rule: "审批流-weixin",
      target_channel: "weixin",
    },
  ]);

  // 2. Create an undirected card
  const madeBroadcast = execute("createCard", [
    {
      key: "broadcast-manual",
      kind: "notice",
      title: "全员通知",
      options: [],
      target_channel: null,
    },
  ]);

  // Deliver to chat
  const stopCtrl = new AbortController();
  await chatAdapter.runner({ hub: chatAdapter.client, signal: stopCtrl.signal });
  await barkAdapter.runner({ hub: barkAdapter.client, signal: stopCtrl.signal });
  await weixinAdapter.runner({ hub: weixinAdapter.client, signal: stopCtrl.signal });

  // Chat received only the broadcast notice
  assert.equal(chatAdapter.state.received.length, 1);
  assert.equal(chatAdapter.state.received[0].id, madeBroadcast.card);

  // Bark received only the broadcast notice
  assert.equal(barkAdapter.state.received.length, 1);
  assert.equal(barkAdapter.state.received[0].id, madeBroadcast.card);

  // Weixin received BOTH: directed weixin card AND broadcast notice
  assert.equal(weixinAdapter.state.received.length, 2);
  const wxCardIds = weixinAdapter.state.received.map((c) => c.id);
  assert.ok(wxCardIds.includes(madeWeixin.card));
  assert.ok(wxCardIds.includes(madeBroadcast.card));

  // Verify the number of cards observed by each fake adapter.
  assert.equal(chatAdapter.state.receivedCount, 1);
  assert.equal(barkAdapter.state.receivedCount, 1);
  assert.equal(weixinAdapter.state.receivedCount, 2);
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
