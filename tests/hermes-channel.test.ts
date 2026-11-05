// The hermes channel: what a card says reaches whichever chat `hermes send` already reaches. No message is really
// sent here — a stand-in `hermes` records what it was asked to send, and exits as the test tells it to.
// Failure modes: the card is sent without its link, so it cannot be answered; an update sends the whole card again;
// a failed send is reported as delivered; a missing target starts a channel that can never work; a long body is cut
// off by the chat rather than by us; shutting down is counted as a failed send.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import hermes from "../plugins/hermes/channel.ts";
import type { Card, ChannelContext } from "../host/channels.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-hermes-channel-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A `hermes` that writes down its arguments and what it was given, then fails if the test said so. */
const program = join(dir, "hermes");
const record = join(dir, "sent.log");
writeFileSync(
  program,
  `#!/bin/sh\n{ printf 'ARGS %s\\n' "$*"; cat; printf '\\nEND\\n'; } >> "${record}"\nexit \${FAKE_EXIT:-0}\n`,
);
chmodSync(program, 0o755);

const base: Card = {
  id: 5,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "要不要删",
  text: "占了 10 GB",
  options: ["删", "留着"],
  recommend: 1,
  choice: null,
  answer: null,
  result: null,
  link: "https://hub.test/c/x",
};

const sent = () => {
  try {
    return readFileSync(record, "utf8");
  } catch {
    return "";
  }
};
const clear = () => writeFileSync(record, "");

/** Runs the channel over the cards given, with the hub remembering what it was told. */
async function deliver(cards: Card[], options: Record<string, unknown> = {}) {
  const stop = new AbortController();
  const told: unknown[][] = [];
  const queue = [...cards];
  const hub = {
    nextCard: async () => {
      const card = queue.shift();
      if (!card) {
        stop.abort();
        return { card: null };
      }
      return { card };
    },
    delivered: async (...args: unknown[]) => void told.push(["delivered", ...args]),
    failed: async (...args: unknown[]) => void told.push(["failed", ...args]),
    answer: async () => assert.fail("a chat answers through its link, not the channel"),
  };
  await hermes({
    hub,
    options: { program, target: "photon", ...options },
    log: () => {},
    signal: stop.signal,
  } as unknown as ChannelContext);
  return told;
}

test("a card reaches the chat with its options and a link to answer it", async () => {
  clear();
  const told = await deliver([base]);
  assert.deepEqual(told, [["delivered", 5, 1, "hermes-5"]]);
  const written = sent();
  assert.match(written, /ARGS send --to photon --subject 要不要删 -/);
  assert.match(written, /占了 10 GB/);
  assert.match(written, /1\. 删\n2\. 留着/);
  assert.match(written, /https:\/\/hub\.test\/c\/x/, "without the link the card could not be answered");
});

test("a card already sent is acknowledged again without sending anything", async () => {
  clear();
  const told = await deliver([{ ...base, version: 2, ref: "hermes-5", state: "decided", choice: 1 }]);
  assert.deepEqual(told, [["delivered", 5, 2, "hermes-5"]]);
  assert.equal(sent(), "", "an update has nothing to send");
});

test("a send that fails is reported, not counted as delivered", async () => {
  clear();
  process.env.FAKE_EXIT = "3";
  try {
    const told = await deliver([base]);
    assert.equal(told.length, 1);
    assert.equal(told[0][0], "failed");
    assert.deepEqual(told[0].slice(1, 3), [5, 1]);
  } finally {
    delete process.env.FAKE_EXIT;
  }
});

test("a channel with no target refuses to start", async () => {
  const stop = new AbortController();
  const hub = { nextCard: async () => ({ card: null }), delivered: async () => {}, failed: async () => {} };
  await assert.rejects(
    () => hermes({ hub, options: {}, log: () => {}, signal: stop.signal } as unknown as ChannelContext),
    /needs a target/,
  );
});

test("a body longer than a chat takes is cut short here, with a mark that it was", async () => {
  clear();
  await deliver([{ ...base, text: "字".repeat(4000), options: [], link: null }]);
  const body = sent().split("\n").slice(1, -2).join("\n");
  assert.ok([...body].length <= 3501, `kept ${[...body].length} characters`);
  assert.ok(body.endsWith("…"), "the cut is visible");
});
