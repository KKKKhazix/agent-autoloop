// Failure cases: SSE chunks lose facts, reconnects duplicate them, stale subscriptions mutate new connections, or graphs invent activity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { watchFacts } from "../src/service/facts.ts";
import { useFactStream } from "../src/hooks/useFactStream.ts";
import { buildWorkflow } from "../src/workflow.ts";
import type { HubState, Fact } from "../src/types/console.ts";

const fact = (seq: number): Fact => ({ seq, at: 1, type: "ingest", changes: [] });

test("authenticated SSE preserves split Unicode and resumes after the supplied sequence", async () => {
  const data = new TextEncoder().encode(
    'id: 8\r\nevent: fact\r\ndata: {"seq":8,"at":1,"type":"ingest","changes":[],"note":"中文"}\r\n\r\n',
  );
  const received: Fact[] = [];
  let opened = false;
  await watchFacts(
    "owner",
    7,
    new AbortController().signal,
    (f) => received.push(f),
    () => (opened = true),
    async (url, init) => {
      assert.equal(url, "/v1/stream?after=7");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer owner");
      return new Response(
        new ReadableStream({
          start(c) {
            for (const byte of data) c.enqueue(Uint8Array.of(byte));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  );
  assert.equal(opened, true);
  assert.deepEqual(
    received.map((f) => f.seq),
    [8],
  );
});

test("a superseded stream is aborted and cannot publish into a new connection", async () => {
  const callbacks: ((f: Fact) => void)[] = [];
  const signals: AbortSignal[] = [];
  const stream = useFactStream({
    onChange() {},
    subscribe: async (_key, _after, signal, onFact, onOpen) => {
      signals.push(signal);
      callbacks.push(onFact);
      onOpen();
      await new Promise(() => {});
    },
  });
  stream.connect("old");
  stream.connect("new");
  callbacks[0]!(fact(9));
  callbacks[1]!(fact(2));
  callbacks[1]!(fact(2));
  assert.equal(signals[0]!.aborted, true);
  assert.deepEqual(
    stream.activity.value.map((f) => f.seq),
    [2],
  );
  stream.disconnect();
  assert.equal(signals[1]!.aborted, true);
  assert.equal(stream.status.value, "disconnected");
});

test("a broken stream reconnects with its last accepted sequence and marks data stale", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const after: number[] = [];
  const stream = useFactStream({
    onChange() {},
    retryDelay: 10,
    subscribe: async (_key, cursor, _signal, onFact, onOpen) => {
      after.push(cursor);
      onOpen();
      if (after.length === 1) {
        onFact(fact(3));
        throw new Error("offline");
      }
      await new Promise(() => {});
    },
  });
  stream.connect("owner");
  await new Promise((r) => setImmediate(r));
  assert.equal(stream.status.value, "reconnecting");
  t.mock.timers.tick(11);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(after, [0, 3]);
  assert.equal(stream.status.value, "live");
  stream.disconnect();
});

const state = {
  sources: [{ name: "来源", events: 2 }],
  lines: [{ name: "规则" }],
  agents: [{ name: "助手", online: true }],
  cards: [{ kind: "ask", state: "open" }],
  totals: { queued: 1, running: 1, doneToday: 1, unknown: 0 },
} as HubState;
test("workflow animates only known active execution while connected and never claims an idle agent is busy", () => {
  const live = buildWorkflow(state, null, [], true);
  assert.ok(live.edges.some((e) => e.animated));
  assert.equal(live.nodes.find((n) => n.id === "human")?.data?.status, "waiting");
  const stale = buildWorkflow(state, null, [], false);
  assert.ok(stale.edges.every((e) => !e.animated));
  const idle = buildWorkflow({ ...state, totals: { ...state.totals, running: 0, queued: 0 } }, null, [], true);
  assert.ok(idle.edges.every((e) => !e.animated));
});
