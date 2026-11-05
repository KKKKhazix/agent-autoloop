import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { at, setup } from "./helpers.ts";

const home = setup("card-version-concurrency");
const { ingest, claimNext, started, finish, db } = await import("../host/runtime.ts");
const { all, one, run } = await import("./storage.ts");

const clean = () => {
  for (const table of ["run_events", "runs", "events", "seen", "cards", "deliveries", "timers"]) {
    run(`DELETE FROM ${table}`);
  }
};

const note = (n: number) => ({ id: `feedback:${n}`, type: "feedback.new", subject: `#${n}` });
const card = (id: number) => one<any>("SELECT * FROM cards WHERE id = ?", [id])!;

/** A run that ends by asking, creating an open card. */
function asked(n: number, now = at(0)) {
  ingest("app", note(n), now);
  const job = claimNext("w1", `c${n}`, now)!;
  started(job.run, job.token, { session: `s-${n}` }, now);
  finish(
    job.run,
    job.token,
    {
      outcome: "done",
      summary: "等你决定",
      ask: [{ title: `选项-${n}`, text: "请选择", options: ["同意", "拒绝"] }],
    },
    now,
  );
  return one<{ id: number }>("SELECT id FROM cards WHERE title = ? ORDER BY id DESC", [`选项-${n}`])!.id;
}

interface WorkerResult {
  ok: boolean;
  value?: any;
  error?: {
    name: string;
    message: string;
    code?: string;
  };
  startedAt?: number;
  endedAt?: number;
}

interface WorkerSpec {
  action: "answer" | "resolve";
  id: number;
  choice?: number;
  text?: string;
  by?: string;
  expectedVersion?: number;
  reason?: string;
  now?: number;
}

async function runConcurrentOperations(
  specA: WorkerSpec,
  specB: WorkerSpec,
  homeDir: string,
  timeoutMs = 5000,
): Promise<[WorkerResult, WorkerResult]> {
  const workerScript = join(import.meta.dirname, "card-version-concurrency.worker.ts");
  const env = { ...process.env, AGENT_AUTOLOOP_HOME: homeDir };
  const execArgv = ["--disable-warning=ExperimentalWarning"];

  const pA = fork(workerScript, [], { env, execArgv });
  const pB = fork(workerScript, [], { env, execArgv });
  const children = [pA, pB];

  let lockAcquired = false;
  let timer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (lockAcquired) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      lockAcquired = false;
    }
    for (const child of children) {
      if (!child.killed) {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }
  };

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for child workers`));
    }, timeoutMs);
  });

  // Everything a worker says, and the way it ends, is recorded from the moment it starts: one that dies while a
  // waiter is still being set up is a failure at once, not a wait until the whole test times out.
  const watch = (child: typeof pA, name: string) => {
    const seen: any[] = [];
    const waiting: Array<{ match: (msg: any) => boolean; resolve: (msg: any) => void; reject: (e: Error) => void }> =
      [];
    let ended: string | null = null;
    const settle = () => {
      for (let i = waiting.length - 1; i >= 0; i--) {
        const waiter = waiting[i];
        const hit = seen.find(waiter.match);
        if (hit) {
          waiting.splice(i, 1);
          waiter.resolve(hit);
        } else if (ended) {
          waiting.splice(i, 1);
          waiter.reject(new Error(`Worker ${name} ${ended} without what was awaited`));
        }
      }
    };
    child.on("message", (msg: any) => {
      seen.push(msg);
      settle();
    });
    child.once("error", (error: Error) => {
      ended = `failed: ${error.message}`;
      settle();
    });
    child.once("exit", (code, signal) => {
      ended = `exited (code: ${code}, signal: ${signal})`;
      settle();
    });
    const awaited = (match: (msg: any) => boolean) =>
      new Promise<any>((resolve, reject) => {
        waiting.push({ match, resolve, reject });
        settle();
      });
    return { child, awaited };
  };

  const a = watch(pA, "A");
  const b = watch(pB, "B");

  try {
    const run = async (): Promise<[WorkerResult, WorkerResult]> => {
      // 1. Both child processes have read the rules and opened their own connection.
      await Promise.all([a.awaited((msg) => msg?.status === "ready"), b.awaited((msg) => msg?.status === "ready")]);

      // 2. This process holds the only write lock.
      db.exec("BEGIN IMMEDIATE");
      lockAcquired = true;

      // 3. Each independent connection meets that lock before anything is written.
      const locked = Promise.all([
        a.awaited((msg) => msg?.status === "locked"),
        b.awaited((msg) => msg?.status === "locked"),
      ]);
      a.child.send({ probe: true });
      b.child.send({ probe: true });
      await locked;

      // 4. Both are now inside their operation, with the lock still held.
      const running = Promise.all([
        a.awaited((msg) => msg?.status === "running"),
        b.awaited((msg) => msg?.status === "running"),
      ]);
      a.child.send({ start: true, spec: specA });
      b.child.send({ start: true, spec: specB });
      await running;

      const results = Promise.all([
        a.awaited((msg) => msg?.status === "result").then((msg) => msg.result),
        b.awaited((msg) => msg?.status === "result").then((msg) => msg.result),
      ]);
      // 5. Neither write may finish while the lock is held here: that is what makes them race once it is released.
      const finishedEarly = await Promise.race([
        results.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
      ]);
      assert.equal(finishedEarly, false, "a write finished while the write lock was held elsewhere");

      db.exec("COMMIT");
      lockAcquired = false;

      return await results;
    };

    const results = await Promise.race([run(), timeoutPromise]);
    if (timer) clearTimeout(timer);
    return results;
  } catch (err) {
    cleanup();
    throw err;
  }
}

test("two independent processes racing to answer the same card at the same expectedVersion: exactly one succeeds, one gets Conflict", async () => {
  clean();
  const id = asked(101, at(0));
  const beforeVersion = card(id).version;

  const [resA, resB] = await runConcurrentOperations(
    { action: "answer", id, choice: 0, by: "worker-A", expectedVersion: beforeVersion, now: at(1) },
    { action: "answer", id, choice: 1, by: "worker-B", expectedVersion: beforeVersion, now: at(1) },
    home,
  );

  // Assert both processes truly overlapped in time during execution
  assert.ok(resA.startedAt != null && resB.startedAt != null);
  assert.ok(resA.endedAt != null && resB.endedAt != null);
  const overlapStart = Math.max(resA.startedAt, resB.startedAt);
  const overlapEnd = Math.min(resA.endedAt, resB.endedAt);
  assert.ok(
    overlapEnd >= overlapStart,
    `Operations must overlap in execution time: A=[${resA.startedAt}, ${resA.endedAt}], B=[${resB.startedAt}, ${resB.endedAt}]`,
  );

  // Exactly one succeeded, one failed with Conflict
  const successes = [resA, resB].filter((r) => r.ok);
  const failures = [resA, resB].filter((r) => !r.ok);

  assert.equal(successes.length, 1, "Exactly one answer must succeed");
  assert.equal(failures.length, 1, "Exactly one answer must fail");

  assert.equal(successes[0].value?.changed, true, "Successful answer changed state");
  assert.equal(
    failures[0].error?.name,
    "Conflict",
    `Failure must be Conflict, got: ${JSON.stringify(failures[0].error)}`,
  );
  assert.equal(failures[0].error?.message, "卡片版本已变化");

  // Invariant assertions on database state
  const updatedCard = card(id);
  assert.equal(updatedCard.state, "decided");
  assert.equal(updatedCard.version, beforeVersion + 1);

  // Exactly one card.answered event
  const answeredEvents = all<any>("SELECT * FROM events WHERE type = 'card.answered'");
  assert.equal(answeredEvents.length, 1, "Exactly one card.answered event must be recorded");
  assert.equal(answeredEvents[0].key, `card:${id}`);
  assert.equal(updatedCard.answer_event, answeredEvents[0].id);

  // Only one follow-up thread / run continuation
  const queuedRuns = all<any>("SELECT * FROM runs WHERE state = 'queued'");
  assert.equal(queuedRuns.length, 1, "Exactly one follow-up run must be enqueued");

  // Only one delivery update fact
  const winnerChoice = successes[0] === resA ? 0 : 1;
  const winnerBy = successes[0] === resA ? "worker-A" : "worker-B";
  assert.equal(updatedCard.choice, winnerChoice);
  assert.equal(updatedCard.by, winnerBy);
});

test("two independent processes racing answer vs resolve on the same open card: exactly one proceeds, state is consistent", async () => {
  clean();
  const id = asked(102, at(0));
  const beforeVersion = card(id).version;

  const [resAnswer, resResolve] = await runConcurrentOperations(
    { action: "answer", id, choice: 0, by: "answerer", expectedVersion: beforeVersion, now: at(1) },
    { action: "resolve", id, reason: "经人工核实已不需处理", by: "resolver", now: at(1) },
    home,
  );

  assert.ok(resAnswer.startedAt != null && resResolve.startedAt != null);
  assert.ok(resAnswer.endedAt != null && resResolve.endedAt != null);
  const overlapStart = Math.max(resAnswer.startedAt, resResolve.startedAt);
  const overlapEnd = Math.min(resAnswer.endedAt, resResolve.endedAt);
  assert.ok(
    overlapEnd >= overlapStart,
    `Operations must overlap in execution time: answer=[${resAnswer.startedAt}, ${resAnswer.endedAt}], resolve=[${resResolve.startedAt}, ${resResolve.endedAt}]`,
  );

  const updatedCard = card(id);
  assert.equal(updatedCard.version, beforeVersion + 1, "Version moves forward exactly once");

  if (resAnswer.ok) {
    // Answer won the race
    assert.equal(resAnswer.value?.changed, true);
    assert.equal(updatedCard.state, "decided");
    assert.equal(updatedCard.by, "answerer");

    // Resolve lost: since card is already 'decided' (not 'open'), resolve returns false
    assert.equal(resResolve.ok, true);
    assert.equal(resResolve.value, false, "Resolve on non-open card returns false");

    // Exactly one card.answered event and one woke thread
    assert.equal(all("SELECT * FROM events WHERE type = 'card.answered'").length, 1);
    assert.equal(all("SELECT * FROM runs WHERE state = 'queued'").length, 1);
  } else {
    // Resolve won the race
    assert.equal(resResolve.ok, true);
    assert.equal(resResolve.value, true, "Resolve on open card returns true");
    assert.equal(updatedCard.state, "closed");
    assert.equal(updatedCard.result, "经人工核实已不需处理");

    // Answer lost: card version moved from beforeVersion to beforeVersion + 1, so expectedVersion failed with Conflict
    assert.equal(resAnswer.ok, false);
    assert.equal(resAnswer.error?.name, "Conflict");
    assert.equal(resAnswer.error?.message, "卡片版本已变化");

    // No card.answered event and no queued runs
    assert.equal(all("SELECT * FROM events WHERE type = 'card.answered'").length, 0);
    assert.equal(all("SELECT * FROM runs WHERE state = 'queued'").length, 0);
  }
});
