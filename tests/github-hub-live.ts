import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import type { Fact } from "../kernel/evolve.ts";
import { GITHUB_EVIDENCE, GITHUB_OBSERVATION, readGitHubReceipt } from "../plugins/github/receipt.ts";

if (!process.argv[2]) throw new Error("Pass a read-only Tracker snapshot path to compare");
const old = JSON.parse(readFileSync(process.argv[2], "utf8"));
const scope = old.scope.github;
assert.deepEqual(scope, { repo: "HKUDS/DeepTutor", author: "LaiYongqiang" }, "only the public test scope is allowed");
const home = mkdtempSync(join(tmpdir(), "github-hub-live-"));
const root = resolve(import.meta.dirname, "..");
const rule = "github-collector-acceptance";
const requestRule = "github-request-acceptance";
const workerName = "github-test-worker";
const repo = scope.repo.toLowerCase();

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  probe.close();
  await once(probe, "close");
  return address.port;
}

function audit(batch: any) {
  const legacy = old.payload.items.filter((entry: any) => entry.platform === "github");
  const evidence = new Map<string, any>(
    batch.observations.map((entry: any) => [`${entry.kind}:${entry.number}`, entry]),
  );
  const missing: string[] = [];
  const differences: Record<string, string[]> = {};
  const ciDuplicateCounts: { key: string; legacy: number; observed: number; unique: number }[] = [];
  const compare = (key: string, facet: string, left: unknown, right: unknown) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) (differences[facet] ??= []).push(key);
  };
  const sorted = (values: unknown[] = []) => [...values].sort();
  const ids = (values: any[] = []) => sorted(values.map((value) => String(value.id)));
  const activity = (values: any[], timestamp: string, review = false) =>
    sorted(
      values.map((value) =>
        JSON.stringify([
          String(value.id),
          String(value.author ?? "").toLowerCase(),
          Date.parse(value[timestamp]),
          ...(review ? [value.state] : []),
        ]),
      ),
    );
  for (const item of legacy) {
    const key = `${item.kind}:${item.number}`;
    const observation = evidence.get(key);
    if (!observation) {
      missing.push(key);
      continue;
    }
    const fields = observation.fields;
    if (!fields) {
      missing.push(key);
      continue;
    }
    for (const facet of ["title", "body", "state", "url"]) compare(key, facet, item[facet], fields[facet]);
    compare(key, "updatedAt", Date.parse(item.updated_at), Date.parse(fields.updatedAt));
    compare(key, "labels", sorted(item.labels), sorted(fields.labels));
    compare(
      key,
      "assignees",
      sorted(item.assignees.map((login: string) => login.toLowerCase())),
      sorted(fields.assignees),
    );
    compare(key, "comments", ids(item.comments), ids(fields.comments));
    compare(key, "commentMetadata", activity(item.comments, "created_at"), activity(fields.comments, "createdAt"));
    const related = batch.inferredLinks
      .filter((edge: any) => (item.kind === "pr" ? edge.pr === observation.key : edge.issue === observation.key))
      .map((edge: any) => Number((item.kind === "pr" ? edge.issue : edge.pr).split(":").at(-1)));
    const newLinks = new Set(
      fields.links
        .filter((link: any) => link.repo === repo)
        .map((link: any) => link.number)
        .concat(related),
    );
    const lostLinks = (item.linked_prs ?? item.linked_issues ?? []).filter(
      (link: any) => !newLinks.has(Number(link.number)),
    );
    if (lostLinks.length)
      differences.missingLegacyLink = [
        ...(differences.missingLegacyLink ?? []),
        `${key} -> ${lostLinks.map((link: any) => link.number).join(",")}`,
      ];
    if (item.kind !== "pr") continue;
    for (const [oldField, newField] of [
      ["is_draft", "draft"],
      ["mergeable", "mergeable"],
      ["merge_state_status", "mergeState"],
      ["review_decision", "reviewDecision"],
      ["base_ref", "baseRef"],
    ]) {
      compare(key, newField, item[oldField] || null, fields[newField] || null);
    }
    compare(key, "files", sorted(item.files), sorted(fields.files));
    compare(key, "overlap", sorted(item.overlapping_files), sorted(fields.overlap ?? []));
    compare(key, "reviews", ids(item.reviews), ids(fields.reviews));
    compare(
      key,
      "reviewMetadata",
      activity(item.reviews, "submitted_at", true),
      activity(fields.reviews, "submittedAt", true),
    );
    const checks = fields.ci?.checks ?? [];
    const byName = new Map<string, Set<string>>();
    for (const check of checks) {
      const name = check.workflowName ? `${check.workflowName}/${check.name}` : check.name;
      const status = check.status === "COMPLETED" && check.conclusion ? check.conclusion : check.status;
      const values = byName.get(name) ?? new Set<string>();
      values.add(status);
      byName.set(name, values);
    }
    compare(key, "ciNames", sorted(Object.keys(item.ci_status.checks)), sorted([...byName.keys()]));
    for (const [name, status] of Object.entries<string>(item.ci_status.checks)) {
      if (!byName.get(name)?.has(status)) (differences.ciLegacyStateNotRepresented ??= []).push(`${key} ${name}`);
    }
    if (item.ci_status.total_count !== checks.length) {
      ciDuplicateCounts.push({ key, legacy: item.ci_status.total_count, observed: checks.length, unique: byName.size });
    }
  }
  return {
    snapshotAt: old.dataCheckedAt,
    observedAt: batch.observedAt,
    legacy: legacy.length,
    observed: evidence.size,
    missing,
    added: [...evidence.keys()].filter((key) => !legacy.some((entry: any) => `${entry.kind}:${entry.number}` === key)),
    differences,
    ciDuplicateCounts,
    inferredLinks: batch.inferredLinks.length,
  };
}

try {
  for (const name of Object.keys(process.env)) if (name.startsWith("AGENT_AUTOLOOP_")) delete process.env[name];
  process.env.AGENT_AUTOLOOP_HOME = home;
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const webhookSecret = randomBytes(32).toString("hex");
  const command = [process.execPath, join(root, "plugins/github/hub-collect.ts"), JSON.stringify(scope), "--receipt"];
  const inputs = {
    to: "github-reader",
    cwd: home,
    tell: "never",
    parallel: 1,
    emits: { source: "github-observation", types: [GITHUB_OBSERVATION, GITHUB_EVIDENCE] },
  };
  writeFileSync(
    join(home, "rules.json"),
    JSON.stringify({
      timezone: "Asia/Shanghai",
      sources: {
        github: { name: "GitHub", adapter: "github" },
        "github-request": { name: "GitHub request" },
        "github-observation": { name: "GitHub observation" },
      },
      agents: {
        "github-reader": {
          name: "GitHub reader",
          worker: workerName,
          use: "command",
          access: "read",
          command,
          timeout: 3,
        },
      },
      rules: [
        { ...inputs, name: rule, when: { cron: "* * * * *" } },
        { ...inputs, name: requestRule, when: { source: "github-request", types: ["github.verify.requested"] } },
      ],
    }),
    { mode: 0o600 },
  );
  writeFileSync(join(home, "secrets.env"), `AGENT_AUTOLOOP_SECRET_GITHUB=${webhookSecret}\n`, { mode: 0o600 });
  const { addKey, db } = await import("../host/runtime.ts");
  const owner = addKey("owner", "github-test-owner");
  const requester = addKey("source", "github-request");
  const worker = { name: workerName, key: addKey("worker", workerName) };
  db.close();
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({ url, owner, worker, hub: { listen: `127.0.0.1:${port}`, publicUrl: url } }),
    { mode: 0o600 },
  );
  const child = spawn(process.execPath, [join(root, "bin/agent-autoloop.ts"), "up"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (data) => {
    log += String(data);
  });
  child.stderr.on("data", (data) => {
    log += String(data);
  });
  const send = (path: string, body?: object, authenticated = true, key = owner) =>
    fetch(`${url}${path}`, {
      method: body ? "POST" : "GET",
      body: body ? JSON.stringify(body) : undefined,
      headers: { ...(authenticated ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
      signal: AbortSignal.timeout(2500),
    });
  const until = async <Value>(action: () => Promise<Value | undefined>, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && child.exitCode === null) {
      const result = await action().catch(() => undefined);
      if (result !== undefined) return result;
      await wait(250);
    }
    throw new Error(`isolated Hub did not finish: ${log.slice(-2500)}`);
  };
  const state = async () => (await send("/v1/state")).json();
  const collectRun = async (runId: number) => {
    const run: any = await until(
      async () => (await state()).runs.find((run: any) => run.id === runId && run.state === "done"),
      135_000,
    );
    const runs = join(home, "worker", "runs");
    const matches = readdirSync(runs).filter((name) => name.startsWith(`${run.id}-`));
    assert.equal(matches.length, 1, "each tested run used a single worker attempt");
    const dir = join(runs, matches[0]);
    const context = JSON.parse(readFileSync(join(dir, "context.json"), "utf8"));
    const facts: Fact[] = await (await send(`/v1/runs/${run.id}/why`)).json();
    const receipt = readGitHubReceipt(
      facts.flatMap((fact) =>
        fact.changes.flatMap(({ table, row }) =>
          table === "events" && row?.source === "github-observation" && row.subject === `github:run:${run.id}`
            ? [{ id: row.key, type: row.type, subject: row.subject, detail: row.detail }]
            : [],
        ),
      ),
    );
    assert.ok(receipt?.report, JSON.stringify(receipt));
    return {
      id: run.id,
      state: run.state,
      manual: run.manual,
      attempts: matches.length,
      summary: run.summary,
      event: context.events[0].type,
      report: receipt.report,
    };
  };
  const manualPath = `/v1/rules/${rule}/run`;
  const manual = async (subject: string) => {
    const response = await send(manualPath, { subject });
    assert.equal(response.status, 200);
    return collectRun((await response.json()).run);
  };
  try {
    await until(async () => ((await send("/healthz")).ok ? true : undefined));
    const hookBody = JSON.stringify({
      action: "created",
      repository: { full_name: scope.repo },
      issue: { number: 2471 },
      comment: { body: "isolated webhook test" },
    });
    const signature = `sha256=${createHmac("sha256", webhookSecret).update(hookBody).digest("hex")}`;
    const webhook = (signed: string) =>
      fetch(`${url}/v1/in/github`, {
        method: "POST",
        body: hookBody,
        headers: {
          "x-github-event": "issue_comment",
          "x-github-delivery": "isolated-github-delivery",
          "x-hub-signature-256": signed,
        },
        signal: AbortSignal.timeout(2500),
      });
    const unauthorized = (await webhook("sha256=00")).status;
    assert.equal(unauthorized, 401);
    const signed = await webhook(signature);
    assert.equal(signed.status, 200);
    const accepted = (await signed.json()).events[0];
    assert.equal(accepted.duplicate, false);
    assert.deepEqual(accepted.routed, []);
    const replay = (await (await webhook(signature)).json()).events[0];
    assert.equal(replay.duplicate, true);
    assert.equal(replay.event, accepted.event);
    assert.ok([401, 403].includes((await send(manualPath, { subject: `github:${repo}:pr:2475` }, false)).status));
    const refreshed = await manual(`github:${repo}:pr:2475`);
    assert.equal(refreshed.event, "run.manual");
    assert.equal(refreshed.report.status, "complete");
    assert.equal(refreshed.report.batches[0].observations.length, 1);
    const requestResponse = await send(
      "/v1/events",
      { id: "interactive-refresh", type: "github.verify.requested", subject: `github:${repo}:pr:2475` },
      true,
      requester,
    );
    assert.equal(requestResponse.status, 200);
    const acceptedRequest = await requestResponse.json();
    assert.deepEqual(acceptedRequest.routed, [requestRule]);
    const sourceResult = await until(async () => {
      const response = await send(`/v1/events/${acceptedRequest.event}`, undefined, true, requester);
      const outcome = await response.json();
      const completed = outcome.runs?.find((run: any) => run.state === "done");
      return completed ? readGitHubReceipt(completed.events ?? []) : undefined;
    });
    assert.equal(sourceResult?.status, "complete");
    assert.equal(
      sourceResult?.report?.batches[0].observations[0].fingerprint,
      refreshed.report.batches[0].observations[0].fingerprint,
    );
    const failed = await manual(`github:${repo}:issue:2147483647`);
    assert.equal(failed.report.status, "failed");
    assert.match(failed.summary, /失败/);
    const rejected = await manual("github:other/repo:pr:2475");
    assert.equal(rejected.report.status, "rejected");
    const scheduled: number = await until(
      async () =>
        (await state()).runs.find(
          (run: any) => !run.manual && run.rule === rule && ["claimed", "done"].includes(run.state),
        )?.id,
      80_000,
    );
    assert.equal((await send(`/v1/rules/${rule}/pause`, {})).status, 200);
    const discovered = await collectRun(scheduled);
    assert.equal(discovered.event, "schedule.tick");
    assert.equal(
      discovered.report.status,
      "complete",
      JSON.stringify(
        discovered.report.batches.map((batch: any) => ({
          problems: batch.problems,
          objects: batch.observations
            .filter((item: any) => item.problems.length)
            .map((item: any) => ({ key: item.key, problems: item.problems })),
        })),
      ),
    );
    assert.ok(discovered.report.batches[0].observations.length > 1);
    const previous = refreshed.report.batches[0].observations[0];
    const repeated = discovered.report.batches[0].observations.find((item: any) => item.key === previous.key);
    assert.ok(repeated?.fingerprint);
    if (process.argv[3]) {
      writeFileSync(process.argv[3], JSON.stringify(discovered.report), { flag: "wx", mode: 0o600 });
    }
    const summarize = ({ report, ...run }: Awaited<ReturnType<typeof collectRun>>) => ({
      ...run,
      status: report.status,
      counts: report.batches.map((batch: any) => batch.observations.length),
    });
    console.log(
      JSON.stringify(
        {
          hub: [refreshed, failed, rejected, discovered].map(summarize),
          webhook: {
            invalidSignatureStatus: unauthorized,
            signedStatus: signed.status,
            duplicateRecognized: replay.duplicate,
          },
          manualAndScheduledFingerprintsMatch: previous.fingerprint === repeated.fingerprint,
          audit: audit(discovered.report.batches[0]),
        },
        null,
        2,
      ),
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await stopped;
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
