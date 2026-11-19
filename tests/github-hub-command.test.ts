// Failure modes: a manual subject escapes the configured repository, unrelated events trigger a pull, or a failed read looks like success.
import assert from "node:assert/strict";
import { test } from "node:test";
import { githubHubRequests, runGitHubHubCollection } from "../plugins/github/hub-collect.ts";

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
