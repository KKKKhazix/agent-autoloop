// Failure modes: the worker cannot run ps at all (the sandbox forbids it, or it is missing or not executable), and it
// reports a run that is still going as finished because the failed lookup was read as "the process is gone".
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-worker-look-"));
const home = join(scratch, "home");
const project = join(scratch, "project");
const bin = join(scratch, "bin");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
mkdirSync(bin, { recursive: true });
process.env.AGENT_AUTOLOOP_HOME = home;
process.env.SHELL = "/bin/sh";
after(() => rmSync(scratch, { recursive: true, force: true }));
const { createWorker } = await import("../worker/worker.ts");

/** Put a ps in front of the real one that answers the question the way a gone process does. */
function psSaysGone() {
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nexit 1\n`, { mode: 0o755 });
  chmodSync(join(bin, "ps"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

/** Put a ps in front of the real one that cannot be run, the way a sandbox refuses it. */
function psCannotRun() {
  writeFileSync(join(bin, "ps"), `#!/bin/sh\nexit 0\n`, { mode: 0o644 });
  chmodSync(join(bin, "ps"), 0o644);
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
}

function workerThatReports(results: any[], job: any) {
  let claimed = false;
  return createWorker({
    name: "test",
    wait: 0,
    hub: {
      work: async () => {
        const next = claimed ? null : job;
        claimed = true;
        return { job: next, cancel: [] };
      },
      started: async () => ({}),
      result: async (_run: number, _token: string, body: unknown) => {
        results.push(body);
        return {};
      },
    } as any,
  });
}

/** Each run gets its own number so one run's exit file is never read as another's. */
function jobFor(run: number, seconds: number) {
  return {
    run,
    token: "test-token",
    attempt: 1,
    session: null,
    askFirst: [],
    rule: { name: "lookup", cwd: project, prompt: "Read the input." },
    agent: {
      id: "a",
      name: "Agent",
      use: "command",
      access: "edit",
      command: ["/bin/sh", "-c", `sleep ${seconds}`],
    },
    context: { events: [], answers: [], timers: [], waiting: [], open: [], decided: [] },
  };
}

test("a run whose process is gone is reported as finished", async () => {
  psSaysGone();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(12, 0));
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "the finished run was never reported");
});

test("a run that cannot be looked up is not reported as finished", async () => {
  psCannotRun();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(11, 30));
  for (let i = 0; i < 60 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 0, "the run was reported before it finished");
});

test("a run that cannot be looked up is reported once its exit file shows up", async () => {
  psCannotRun();
  const results: any[] = [];
  const worker = workerThatReports(results, jobFor(14, 0));
  for (let i = 0; i < 100 && !results.length; i++) {
    await worker.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(results.length, 1, "the finished run was never reported");
});
