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

function fakeCli(name: string, body: string) {
  const entry = join(dir, `${name}.cjs`);
  writeFileSync(
    entry,
    `#!/usr/bin/env node
${body}`,
    { mode: 0o755 },
  );
  if (process.platform !== "win32") return entry;
  const shim = join(dir, `${name}.cmd`);
  writeFileSync(shim, `@ECHO off\r\nSET "dp0=%~dp0"\r\nnode "%dp0%\\${name}.cjs" %*\r\n`);
  return shim;
}

test(
  "feishu: fast patches reuse one process and a failed patch retries the original message",
  { timeout: 15_000 },
  async ({ signal }) => {
    const log = join(dir, "fast-patch.log");
    const fastCli = fakeCli(
      "lark-fast",
      `
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const log = ${JSON.stringify(log)};
if (process.argv[2] === "event") {
  process.stdin.resume();
} else if (process.argv[2] === "autoloop-card-patches") {
  appendFileSync(log, "start\\n");
  let requests = 0;
  createInterface({ input: process.stdin }).on("line", (line) => {
    appendFileSync(log, line + "\\n");
    console.log(JSON.stringify({ ok: ++requests === 1 }));
  });
} else {
  process.exitCode = 1;
}
`,
    );
    const lark = fakeCli(
      "lark-fallback",
      `
const { appendFileSync } = require("node:fs");
const log = ${JSON.stringify(log)};
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  appendFileSync(log, process.argv.slice(2).join(" ") + "\\n" + Buffer.concat(chunks) + "\\n");
  console.log(JSON.stringify({ ok: true }));
});
`,
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
      async failed(_id: number, _version: number, error: string) {
        stop.abort();
        assert.fail(error);
      },
      async delivered(...args: unknown[]) {
        delivered.push(args);
      },
    };
    await feishu({
      hub: hub as any,
      options: { user: "ou_me", lark, fastCli },
      log: () => {},
      signal: AbortSignal.any([signal, stop.signal]),
    });
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
  },
);

test(
  "feishu: the callback acknowledges only a committed answer and reports a duplicate or rejection",
  { timeout: 15_000 },
  async ({ signal }) => {
    const file = join(dir, "toast-replies.ndjson");
    const event = {
      action_value: JSON.stringify({ card: 5, choice: 1 }),
      operator_id: "ou_me",
      message_id: "om_5",
    };
    const fastCli = fakeCli(
      "lark-toast",
      `
const { createWriteStream } = require("node:fs");
if (process.argv[2] === "autoloop-card-callbacks") {
  for (const receipt of [1, 2, 3]) {
    console.log(JSON.stringify({ ...${JSON.stringify(event)}, receipt }));
  }
  process.stdin.pipe(createWriteStream(${JSON.stringify(file)}));
} else {
  process.stdin.resume();
}
`,
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
      signal: AbortSignal.any([signal, stop.signal]),
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
  },
);
