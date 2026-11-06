// A status question must start while all ordinary slots are occupied. Background work cannot borrow the reserved
// slot; priority comes only from trusted rules; equal-priority work stays FIFO; a lost claim keeps the same job.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setup } from "./helpers.ts";

const home = setup("priority");
const gate = join(home, "release");
const file = join(home, "rules.json");
const fixture = {
  sources: { local: { name: "local" } },
  agents: {
    background: {
      name: "background",
      worker: "w1",
      use: "command",
      command: [
        "/bin/sh",
        "-c",
        `i=0; until [ -e '${gate}' ] || [ $i -ge 600 ]; do sleep 0.05; i=$((i+1)); done; echo done`,
      ],
    },
    owner: { name: "owner", worker: "w1", use: "command", command: ["/bin/sh", "-c", "echo answered"] },
  },
  rules: [
    { name: "background", when: { source: "local", types: ["background"] }, to: "background", cwd: home, parallel: 10 },
    { name: "owner", when: { source: "local", types: ["owner"] }, to: "owner", cwd: home, priority: 100 },
  ],
};
writeFileSync(file, JSON.stringify(fixture));
process.env.AGENT_AUTOLOOP_RULES = file;
const { serve } = await import("../host/http.ts");
const { addKey, execute, getView } = await import("../host/runtime.ts");
const { parseRules } = await import("../protocol/rules.ts");
const { hubClient } = await import("../protocol/client.ts");
const { createWorker } = await import("../worker/worker.ts");
const sourceKey = addKey("source", "local");
const workerKey = addKey("worker", "w1");
const server = serve(0, "127.0.0.1");
let base = "";
before(async () => {
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const event = (type: string, id: string) =>
  execute("ingest", ["local", { id, type, subject: id, detail: "priority=100" }]);

test("priority is validated on rules, not taken from event text", () => {
  for (const value of [-1, 1.5, "100", 101]) {
    const invalid = structuredClone(fixture);
    invalid.rules[1].priority = value as number;
    assert.throws(() => parseRules(JSON.stringify(invalid), Date.now(), "UTC"), /priority/);
  }
});

test("owner work has an extra slot while five background jobs run, including after restart", async () => {
  for (let i = 0; i < 6; i++) event("background", `background-${i}`);
  const client = hubClient(base, workerKey);
  let worker = createWorker({ hub: client, name: "w1", capacity: 5, reservedCapacity: 1, wait: 0 });
  try {
    for (let i = 0; i < 5; i++) await worker.tick();
    assert.equal(worker.entries().length, 5);
    await worker.tick();
    assert.equal(worker.entries().length, 5, "ordinary jobs cannot use the reserved slot");
    worker = createWorker({ hub: client, name: "w1", capacity: 5, reservedCapacity: 1, wait: 0 });
    event("owner", "question");
    await worker.tick();
    assert.equal(worker.entries().length, 6);
    assert.equal(worker.entries().filter((e) => e.job.rule.name === "owner").length, 1);
    assert.equal(getView().select("runs", { state: "queued" }).length, 1, "the sixth background job still waits");
    const entries = worker.entries();
    assert.ok(entries.every((entry) => readFileSync(join(entry.dir, "entry.json"), "utf8")));
  } finally {
    writeFileSync(gate, "");
    const end = Date.now() + 15_000;
    while (worker.entries().length || getView().select("runs", { state: "queued" }).length) {
      assert.ok(Date.now() < end, "agents and results are reaped");
      await worker.tick();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
});

test("higher priority overtakes older jobs, equal priority stays FIFO, and replay ignores a new filter", async () => {
  event("background", "fifo-first");
  event("background", "fifo-second");
  event("owner", "new-question");
  const client = hubClient(base, workerKey);
  const first = await client.work({ claim: "priority", wait: 0, running: [], capacity: true });
  assert.equal(first.job.rule.name, "owner");
  const replay = await client.work({ claim: "priority", wait: 0, running: [], capacity: true, minPriority: 100 });
  assert.equal(replay.job.run, first.job.run);
  await client.result(replay.job.run, replay.job.token, { outcome: "done" });
  const older = await client.work({ claim: "older", wait: 0, running: [], capacity: true });
  assert.equal(older.job.context.events[0].id, "fifo-first");
  const held = await client.work({ claim: "older", wait: 0, running: [], capacity: true, minPriority: 100 });
  assert.equal(held.job.run, older.job.run, "claim replay is not filtered away");
  const younger = await client.work({ claim: "younger", wait: 0, running: [], capacity: true });
  assert.equal(younger.job.context.events[0].id, "fifo-second");
  for (const job of [held.job, younger.job]) await client.result(job.run, job.token, { outcome: "done" });
});

test("invalid priority filters are rejected before work is claimed", async () => {
  for (const value of ["bad", "-1", "1.5", "101", ""]) {
    const response = await fetch(`${base}/v1/work?claim=invalid&wait=0&minPriority=${value}`, {
      headers: { authorization: `Bearer ${workerKey}` },
    });
    assert.equal(response.status, 400);
  }
  const response = await fetch(`${base}/v1/work?claim=source&wait=0&minPriority=1`, {
    headers: { authorization: `Bearer ${sourceKey}` },
  });
  assert.equal(response.status, 401);
});
