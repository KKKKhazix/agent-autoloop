// The scheduled and manual paths can otherwise read the same object twice while queued, or produce a receipt the requester cannot read.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { hubClient } from "../protocol/client.ts";
import { setup } from "./helpers.ts";

const directory = setup("gitcode-hub");
const rulesFile = join(directory, "rules.json");
process.env.AGENT_AUTOLOOP_RULES = rulesFile;

test("real Hub and worker dispatch cron and manual requests, coalesce a queued target and persist evidence", async () => {
  const example = new URL("../plugins/gitcode/rules.example.json", import.meta.url);
  const config = join(directory, "gitcode.json");
  const secret = join(directory, "token");
  const preload = join(directory, "fake-api.mjs");
  const log = join(directory, "requests.jsonl");
  const subject = "gitcode:team/repo:pr:7";
  writeFileSync(config, JSON.stringify({ account: "me", repositories: ["Team/Repo"], targets: [subject] }));
  writeFileSync(secret, "fixture-token\n", { mode: 0o600 });
  writeFileSync(
    preload,
    `import { appendFileSync } from 'node:fs';
    globalThis.fetch = async (input, options) => {
      const url = new URL(input);
      if (url.origin !== 'https://api.gitcode.com' || options.headers['private-token'] !== 'fixture-token')
        throw new Error('invalid mock request');
      appendFileSync(${JSON.stringify(log)}, JSON.stringify(url.pathname) + '\\n');
      if (url.pathname.endsWith('/user')) return Response.json({login:'me'});
      if (url.pathname.endsWith('/pulls') && url.searchParams.get('author') === 'me' && url.searchParams.get('page') === '1')
        return Response.json([{number:7, user:{login:'me'}}]);
      if (url.pathname.endsWith('/pulls/7')) return Response.json({number:7, title:'test PR', state:'open',
          head:{sha:'a'.repeat(40)}, base:{sha:'b'.repeat(40),ref:'main'}});
      if (url.pathname.endsWith('/pulls/7/files') && url.searchParams.get('page') === '1')
        return Response.json([{filename:'path.ts'}]);
      if (url.pathname.endsWith('/branches/main')) return Response.json({commit:{sha:'c'.repeat(40)}});
      if (url.pathname.includes('/compare/')) return Response.json({files:[{filename:'path.ts'}],truncated:false});
      return Response.json([]);
    };`,
  );
  const rules = JSON.parse(readFileSync(example, "utf8"));
  for (const agent of Object.values<{ command: string[]; worker: string }>(rules.agents)) {
    const mode = agent.command[2];
    const program = join(import.meta.dirname, "..", "plugins", "gitcode", "run.ts");
    agent.command = [
      process.execPath,
      "--import",
      pathToFileURL(preload).href,
      program,
      mode,
      config,
      ...(mode === "collect" ? [secret] : []),
    ];
  }
  for (const rule of rules.rules) rule.cwd = directory;
  const hour = 60 * 60_000;
  const slot = Math.floor((Date.now() - 12 * hour) / hour) * hour;
  rules.timezone = "UTC";
  rules.rules[0].when.cron = `0 ${new Date(slot).getUTCHours()} * * *`;
  writeFileSync(rulesFile, JSON.stringify(rules));

  const hub = await import("./hub.ts");
  const { serve } = await import("../host/http.ts");
  const { createWorker } = await import("../worker/worker.ts");
  const sourceKey = hub.addKey("source", "gitcode-request");
  const workerKey = hub.addKey("worker", "gitcode-worker");
  hub.tick(slot - 60_000);
  hub.tick(slot);
  const server = serve(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const source = hubClient(base, sourceKey);
    const worker = createWorker({ hub: hubClient(base, workerKey), name: "gitcode-worker", capacity: 1, wait: 0 });
    await worker.tick();
    const request = { id: "manual-7", type: "gitcode.verify.requested", subject };
    const sent = await source.event(request);
    assert.deepEqual(sent.routed, ["核实 GitCode"]);
    const duplicate = await source.event(request);
    assert.equal(duplicate.event, sent.event);
    assert.equal(duplicate.duplicate, true);

    const observed = () =>
      hub.all<{ type: string; subject: string }>(
        "SELECT type,subject FROM events WHERE source='gitcode-observation' ORDER BY id",
      );
    for (let attempt = 0; attempt < 40 && observed().length < 8; attempt += 1) {
      await worker.tick();
      await delay(20);
    }
    const response = await fetch(`${base}/v1/events/${sent.event}`, {
      headers: { authorization: `Bearer ${sourceKey}` },
    });
    assert.equal(response.status, 200);
    const outcome = await response.json();
    assert.equal(outcome.runs.length, 1);
    assert.equal(outcome.runs[0].state, "done");
    assert.equal(JSON.parse(outcome.runs[0].events[0].detail).title, "test PR");
    const [overlap] = outcome.runs[0].events
      .map(({ detail }: { detail: string }) => JSON.parse(detail))
      .filter(({ facet }: { facet?: string }) => facet === "overlap");
    assert.equal(overlap.coverage, "complete");
    assert.deepEqual(overlap.paths, ["path.ts"]);
    assert.deepEqual(
      observed()
        .map(({ type }) => type)
        .sort(),
      [
        "gitcode.discovery.observed",
        "gitcode.discovery.observed",
        "gitcode.evidence.observed",
        "gitcode.evidence.observed",
        "gitcode.evidence.observed",
        "gitcode.evidence.observed",
        "gitcode.evidence.observed",
        "gitcode.object.observed",
      ],
    );
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.filter((path) => path.endsWith("/pulls/7")).length, 2);
    assert.equal(calls.filter((path) => path.includes("/compare/")).length, 1);
    assert.equal(calls.filter((path) => path.endsWith("/user")).length, 3);

    const sweep = await source.event({
      id: "manual-sweep",
      type: "gitcode.sweep.requested",
      subject: "gitcode:team/repo:pr:own",
    });
    assert.deepEqual(sweep.routed, ["核实 GitCode"]);
    for (
      let attempt = 0;
      attempt < 40 && observed().filter(({ type }) => type === "gitcode.object.observed").length < 2;
      attempt += 1
    ) {
      await worker.tick();
      await delay(20);
    }
    const rows = hub.all<{ type: string; detail: string }>(
      "SELECT type,detail FROM events WHERE source='gitcode-observation' AND type IN ('gitcode.verify.discovered','gitcode.object.observed') ORDER BY id",
    );
    const [queued] = rows.filter(({ type }) => type === "gitcode.verify.discovered");
    const objects = rows.filter(({ type }) => type === "gitcode.object.observed");
    assert.equal(objects.length, 2);
    assert.equal(JSON.parse(objects[1].detail).scanRun, JSON.parse(queued.detail).scanRun);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
