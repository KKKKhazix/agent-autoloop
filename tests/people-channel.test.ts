// The Feishu channel and cards for a named person, with a stand-in lark-cli. Failure cases: a card for someone is sent to
// the owner, so the person never sees it and the owner can't answer it either; a card with no one named stops going to the
// owner; a settled card for someone that Feishu won't let the bot update is sent again to the owner.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import feishu from "../plugins/feishu/channel.ts";
import type { Card } from "../host/channels.ts";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-people-channel-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const base: Card = {
  id: 5,
  version: 1,
  ref: null,
  kind: "ask",
  state: "open",
  title: "接这个任务吗",
  text: "登录页改版",
  options: ["接", "退回"],
  recommend: 0,
  choice: null,
  answer: null,
  result: null,
  link: null,
};
const alice = { id: "alice", name: "前端 A", address: "ou_a" };

/** Hands `cards` to the channel one by one with a lark-cli that refuses updates; what it ran. */
async function sent(cards: Card[]) {
  const log = join(dir, `lark-${Math.random()}.log`);
  const lark = join(dir, `lark-${Math.random()}`);
  writeFileSync(
    lark,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  *"event consume"*) exec sleep 30 ;;
  *"messages patch"*) cat > /dev/null; exit 1 ;;
  *) cat > /dev/null; echo '{"ok":true,"data":{"message_id":"om_new"}}' ;;
esac
`,
    { mode: 0o755 },
  );
  const stop = new AbortController();
  const queue = [...cards];
  const hub = {
    async nextCard() {
      if (queue.length) return { card: queue.shift()! };
      stop.abort();
      return { card: null };
    },
    async delivered() {
      return {};
    },
    async failed() {
      return {};
    },
    async answer() {
      return { changed: true };
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", lark }, log: () => {}, signal: stop.signal });
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.includes("+messages-send"));
}

test("feishu: a card for someone goes to their address, and one for no one still goes to the owner", async () => {
  const sends = await sent([
    { ...base, to: alice },
    { ...base, id: 6 },
  ]);
  assert.equal(sends.length, 2);
  assert.ok(sends[0].includes("--user-id ou_a "), sends[0]);
  assert.ok(sends[1].includes("--user-id ou_me "), sends[1]);
});

test("feishu: a settled card for someone that can't be updated is sent again to them, not the owner", async () => {
  const [again] = await sent([{ ...base, to: alice, version: 2, ref: "om_old", state: "decided", choice: 0 }]);
  assert.ok(again.includes("--user-id ou_a "), again);
});
