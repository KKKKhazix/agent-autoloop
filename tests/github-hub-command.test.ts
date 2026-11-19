// Failure modes: a manual subject escapes the configured repository, unrelated events trigger a pull, or a failed read looks like success.
import assert from "node:assert/strict";
import { test } from "node:test";
import { githubHubRequests, runGitHubHubCollection } from "../plugins/github/hub-collect.ts";
import { githubReceipt, readGitHubReceipt } from "../plugins/github/receipt.ts";
import { parseEvent } from "../protocol/validate.ts";

const config = { repo: "HKUDS/DeepTutor", author: "LaiYongqiang" };
const tick = { source: "schedule", type: "schedule.tick", subject: "" };
const manual = { source: "schedule", type: "run.manual", subject: "github:hkuds/deeptutor:pr:2475" };

test("the same worker command maps a Hub tick to discovery and a manual target to one repository object", () => {
  const { requests, rejected } = githubHubRequests(config, { events: [tick, tick, manual, manual] });
  assert.deepEqual(requests, [
    { mode: "discover", repo: "hkuds/deeptutor", author: "laiyongqiang" },
    { mode: "verify", repo: "hkuds/deeptutor", kind: "pr", number: 2475 },
  ]);
  assert.equal(rejected, 0);
});

test("an invalid or non-owner manual event cannot widen collection scope or fall back to discovery", async () => {
  const context = {
    events: [
      { ...manual, subject: "github:another/repo:pr:2475" },
      { ...manual, subject: "" },
      { ...manual, source: "github" },
      { ...tick, source: "github" },
    ],
  };
  assert.deepEqual(githubHubRequests(config, context), { requests: [], rejected: 4 });
  const report = await runGitHubHubCollection(config, context, async () => assert.fail("reject before a remote call"));
  assert.equal(report.status, "rejected");
});

test("Hub result preserves a failed refresh as failed, not empty or unchanged", async () => {
  const report = await runGitHubHubCollection(config, { events: [manual] }, async () => {
    throw new Error("token never logged");
  });
  assert.equal(report.status, "failed");
  assert.equal(report.batches[0].observations[0].change, "unknown");
  assert.doesNotMatch(JSON.stringify(report), /token never logged/);
});

test("a configured request source can verify a single object without owner access", () => {
  const event = { ...manual, source: "github-request", type: "github.verify.requested" };
  const { requests, rejected } = githubHubRequests(config, {
    events: [event, { ...event, source: "github" }, { ...event, subject: "github:another/repo:pr:2475" }],
  });
  assert.deepEqual(requests, [{ mode: "verify", repo: "hkuds/deeptutor", kind: "pr", number: 2475 }]);
  assert.equal(rejected, 2);
});

test("receipt preserves a failed observation and rejects missing or mismatched evidence", async () => {
  const report = await runGitHubHubCollection(config, { events: [manual] }, async () => {
    throw new Error("offline");
  });
  const events = githubReceipt(report, "17");
  events.forEach(parseEvent);
  assert.deepEqual(readGitHubReceipt(events)?.report, JSON.parse(JSON.stringify(report)));
  assert.equal(readGitHubReceipt(events.slice(0, -1)), null);
  const [manifest, ...evidence] = events;
  const wrongEvidence = githubReceipt(report, "19").slice(1);
  assert.equal(readGitHubReceipt([manifest, ...evidence, ...wrongEvidence]), null);
});

test("large observations do not masquerade as complete when the receipt cannot carry them", () => {
  const report = { version: 1, status: "complete", batches: [{ text: "😺".repeat(100_000) }] } as const;
  const events = githubReceipt(report, "18");
  events.forEach(parseEvent);
  assert.equal(events.length, 1);
  assert.deepEqual(readGitHubReceipt(events), { status: "partial", reason: "receipt_capacity", report: null });
});
