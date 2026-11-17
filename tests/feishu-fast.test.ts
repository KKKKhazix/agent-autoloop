// Fast Feishu delivery can lose the original card or acknowledge an uncommitted or duplicate answer.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Card } from "../host/channels.ts";
import feishu from "../plugins/feishu/channel.ts";

const dir = mkdtempSync(join(tmpdir(), "feishu-fast-"));
after(() => rmSync(dir, { recursive: true, force: true }));
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

test("feishu: fast patches reuse one process and a failed patch retries the original message", async () => {
  const log = join(dir, "fast-patch.log");
  const fastCli = join(dir, "lark-cli-fast");
  const lark = join(dir, "lark-cli-fallback");
  writeFileSync(
    fastCli,
    `#!/bin/sh
case "$1" in
  event) exec sleep 30 ;;
  autoloop-card-patches)
    echo start >> "${log}"
    IFS= read -r first || exit 1
    echo "$first" >> "${log}"
    echo '{"ok":true}'
    IFS= read -r second || exit 1
    echo "$second" >> "${log}"
    echo '{"ok":false}' ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    lark,
    `#!/bin/sh
echo "$*" >> "${log}"
cat >> "${log}"
echo >> "${log}"
echo '{"ok":true}'
`,
    { mode: 0o755 },
  );
  const stop = new AbortController();
  const cards: Card[] = [
    { ...base, version: 2, ref: "om_5", state: "decided", choice: 1 },
    { ...base, version: 3, ref: "om_5", state: "done", choice: 1, result: "测试结束" },
  ];
  const delivered: unknown[][] = [];
  const hub = {
    async nextCard() {
      const card = cards.shift();
      if (card) return { card };
      stop.abort();
      return { card: null };
    },
    async delivered(...args: unknown[]) {
      delivered.push(args);
    },
  };
  await feishu({ hub: hub as any, options: { user: "ou_me", lark, fastCli }, log: () => {}, signal: stop.signal });
  const [start, first, second, fallback, body] = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(start, "start");
  assert.match(JSON.parse(first).content, /已收到确认/);
  assert.match(JSON.parse(second).content, /已执行：测试结束/);
  assert.match(fallback, /^im messages patch --message-id om_5 /);
  assert.deepEqual(JSON.parse(body), { content: JSON.parse(second).content });
  assert.deepEqual(delivered, [
    [5, 2, "om_5"],
    [5, 3, "om_5"],
  ]);
});

test("feishu: the callback acknowledges only a committed answer and reports a duplicate or rejection", async () => {
  const file = join(dir, "toast-replies.ndjson");
  const fastCli = join(dir, "lark-cli-toast");
  const event = JSON.stringify({
    action_value: JSON.stringify({ card: 5, choice: 1 }),
    operator_id: "ou_me",
    message_id: "om_5",
  });
  writeFileSync(
    fastCli,
    `#!/bin/sh
case "$1" in
  autoloop-card-patches) cat >/dev/null ;;
  autoloop-card-callbacks)
    printf '%s\n' '${event.slice(0, -1)},"receipt":1}' '${event.slice(0, -1)},"receipt":2}' '${event.slice(0, -1)},"receipt":3}'
    exec cat > "${file}" ;;
  *) exec sleep 30 ;;
esac
`,
    { mode: 0o755 },
  );
  const stop = new AbortController();
  let release: () => void = () => {};
  const committed = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const hub = {
    async nextCard() {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { card: null };
    },
    async answer() {
      const call = ++calls;
      if (call === 3) throw new Error("invalid message");
      await committed;
      return { changed: call === 1 };
    },
  };
  const run = feishu({
    hub: hub as any,
    options: { user: "ou_me", lark: fastCli, fastCli, callbackToast: true },
    log: () => {},
    signal: stop.signal,
  });
  const read = () => (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
  try {
    for (let i = 0; i < 100 && !read(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(calls, 3);
    assert.equal(read(), '{"receipt":3,"outcome":"failed"}');
    release();
    for (let i = 0; i < 100 && read().split("\n").length < 3; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(
      read()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        { receipt: 3, outcome: "failed" },
        { receipt: 1, outcome: "accepted" },
        { receipt: 2, outcome: "duplicate" },
      ],
    );
  } finally {
    release();
    stop.abort();
    await run;
  }
});
