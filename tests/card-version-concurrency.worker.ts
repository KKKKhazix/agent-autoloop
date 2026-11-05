// Helper worker for card-version-concurrency tests.
// Runs in an independent OS process, shares the test's isolated AGENT_AUTOLOOP_HOME.
// Communicates via IPC with the parent test process across a synchronization barrier.

const hub = await import("../host/runtime.ts");
const { Conflict, InputError, AuthError, NotFound } = await import("../kernel/errors.ts");

// Signal parent that this child process is ready and connected to hub
if (process.send) {
  process.send({ status: "ready", pid: process.pid });
}

process.on("message", (msg: any) => {
  if (msg?.probe) {
    hub.db.exec("PRAGMA busy_timeout=0");
    try {
      hub.db.exec("BEGIN IMMEDIATE");
      hub.db.exec("ROLLBACK");
      throw new Error("Expected the parent to hold the SQLite write lock");
    } catch (error: any) {
      if (error.errcode !== 5) throw error;
      process.send?.({ status: "locked", pid: process.pid });
    } finally {
      hub.db.exec("PRAGMA busy_timeout=5000");
    }
    return;
  }
  if (msg?.start && msg.spec) {
    const { action, id, choice, text, by, expectedVersion, reason, now } = msg.spec;
    // Notify parent immediately that execution is starting (entering the lock acquisition phase)
    process.send?.({ status: "running", pid: process.pid });
    const startedAt = Date.now();
    try {
      let value: any;
      if (action === "answer") {
        value = hub.answer(id, { choice, text, by, expectedVersion }, now);
      } else if (action === "resolve") {
        value = hub.resolve(id, reason, by, now);
      } else {
        throw new Error(`Unknown action: ${action}`);
      }
      const endedAt = Date.now();
      process.send?.({
        status: "result",
        result: { ok: true, value, startedAt, endedAt },
      });
    } catch (err: any) {
      const endedAt = Date.now();
      const typeName =
        err instanceof Conflict
          ? "Conflict"
          : err instanceof InputError
            ? "InputError"
            : err instanceof AuthError
              ? "AuthError"
              : err instanceof NotFound
                ? "NotFound"
                : (err?.constructor?.name ?? err?.name ?? "Error");

      process.send?.({
        status: "result",
        result: {
          ok: false,
          error: {
            name: typeName,
            message: err?.message ?? String(err),
            code: err?.code,
            stack: err?.stack,
          },
          startedAt,
          endedAt,
        },
      });
    } finally {
      process.exit(0);
    }
  }
});
