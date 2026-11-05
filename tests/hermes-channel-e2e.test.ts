// The whole way a card goes: an event names a channel, the run and its card keep it, and the shipped hermes channel
// hands the words to `hermes send` for that chat. No message leaves the machine: a stand-in `hermes` writes down what
// it was asked to send, so what is checked here is the wiring, not a chat app.
// Failure modes: the card goes to the channel the rule defaults to rather than the one the request named; the other
// channel hears about it too; the delivery is reported without a send; the channel key can read another channel's card.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setup } from "./helpers.ts";

setup("hermes-channel-e2e");

const { serve } = await import("../host/http.ts");
const { addKey, execute } = await import("../host/runtime.ts");
const { hubClient } = await import("../protocol/client.ts");
const { one, run } = await import("./storage.ts");
const { default: hermes } = await import("../plugins/hermes/channel.ts");

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-hermes-e2e-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A `hermes` that records the target and the words, one file per target, and never reaches the network. */
const fakeFor = (name: string) => {
  const program = join(dir, `hermes-${name}`);
  const file = join(dir, `${name}.log`);
  writeFileSync(program, `#!/bin/sh\nprintf '%s\\n' "$*" > "${file}.args"\ncat >> "${file}"\n`);
  chmodSync(program, 0o755);
  return { program, file };
};
const photon = fakeFor("photon");
const weixin = fakeFor("weixin");
const recorded = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const rules = {
  timezone: "Asia/Shanghai",
  sources: { app: { name: "应用" } },
  agents: { a1: { name: "甲", worker: "w1", use: "command", command: ["echo", "ok"] } },
  channels: { imessage: { name: "iMessage", links: true }, wechat: { name: "微信", links: true } },
  rules: [
    {
      name: "告警",
      when: { source: "app", types: ["alert.*"] },
      to: "a1",
      cwd: "/tmp",
      prompt: "看告警。",
      channels: ["imessage", "wechat"],
    },
  ],
  elsewhere: [],
};
execute("rules", [structuredClone(rules)]);

const keys = {
  app: addKey("source", "app"),
  w1: addKey("worker", "w1"),
  imessage: addKey("channel", "imessage"),
  wechat: addKey("channel", "wechat"),
};

const server: Server = serve(0, "127.0.0.1", { commit: "hermes-channel-e2e" });
await new Promise((resolve) => server.once("listening", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"])
    run(`DELETE FROM ${table}`);
};

const post = async (path: string, key: string, body: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(url + path, {
    method: "POST",
    headers: { authorization: " ".repeat(0) + "Bearer" + " " + key, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
};

/** A hub that waits no longer than a moment, so a channel's loop can be stopped. */
const shortWait = (key: string) => {
  const client = hubClient(url, key);
  return { ...client, nextCard: () => client.nextCard(0) };
};

const until = async (check: () => boolean, ms = 8000) => {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error("nothing arrived in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("an event that names a channel reaches that chat, and only that chat", async () => {
  clean();
  writeFileSync(photon.file, "");
  writeFileSync(weixin.file, "");
  const stop = new AbortController();
  const say = { log: () => {} };
  const imessage = hermes({
    hub: shortWait(keys.imessage) as any,
    options: { program: photon.program, target: "photon:any;-;+861****0029" },
    signal: stop.signal,
    ...say,
  });
  const wechat = hermes({
    hub: shortWait(keys.wechat) as any,
    options: { program: weixin.program, target: "weixin:o9cq80wFZX_sloRYbbJHe3Th2J-I@im.wechat" },
    signal: stop.signal,
    ...say,
  });
  try {
    // The event names the channel the rule also allows, which is not the rule's default.
    const taken = await post(
      "/v1/events",
      keys.app,
      { id: "a1", type: "alert.raised", subject: "disk" },
      {
        "x-autoloop-channel": "wechat",
      },
    );
    assert.equal(taken.status, 200, JSON.stringify(taken.json));
    const runRow = one<{ id: number; target_channel: string }>(
      "SELECT id, target_channel FROM runs ORDER BY id DESC LIMIT 1",
    )!;
    assert.equal(runRow.target_channel, "wechat");

    // The worker asks a question, which becomes the card for that channel.
    const claimed = await fetch(url + "/v1/work?claim=e2e&wait=0", {
      headers: { authorization: " ".repeat(0) + "Bearer" + " " + keys.w1 },
    });
    assert.equal(claimed.status, 200);
    const claim = { status: claimed.status, json: await claimed.json() };
    const { job } = claim.json as { job: any };
    assert.equal(job.context.events[0].subject, "disk");
    const done = await post(`/v1/runs/${job.run}/result`, job.token, {
      outcome: "done",
      summary: "要清缓存吗",
      ask: [{ title: "要不要清缓存", text: "占了 40 GB", options: ["清", "不清"] }],
    });
    assert.equal(done.status, 200);

    const args = () => {
      try {
        return readFileSync(`${weixin.file}.args`, "utf8");
      } catch {
        return "";
      }
    };
    await until(() => args().includes("要不要清缓存"));
    assert.equal(recorded(photon.file), "", "the channel the request did not name hears nothing");
    const words = recorded(weixin.file);
    assert.match(words, /1\. 清\n2\. 不清/);
    assert.match(words, /https:\/\/hub\.test\/c\//, "the card comes with the link that answers it");

    const sent = one<{ ref: string }>("SELECT ref FROM deliveries WHERE channel = 'wechat' ORDER BY card_id DESC")!;
    assert.match(sent.ref, /^hermes-\d+$/, "the send is recorded as a delivery");
    assert.match(args(), /send --to weixin:/);
  } finally {
    stop.abort();
    await Promise.allSettled([imessage, wechat]);
  }
});

test("a channel key cannot read a card that belongs to another channel", async () => {
  const other = await fetch(url + "/v1/cards/next?wait=0", {
    headers: { authorization: " ".repeat(0) + "Bearer" + " " + keys.imessage },
  });
  assert.equal(other.status, 200);
  assert.equal((await other.json()).card, null, "the iMessage channel is not handed the WeChat card");
});
