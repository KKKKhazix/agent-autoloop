// Failure modes: hard limits certify complete data, or paginated rerun jobs supply an unproven attempt.
import assert from "node:assert/strict";
import { test } from "node:test";
import { maxJobPages, readAttempts } from "../plugins/github/ci-attempts.ts";
import { cursorPages, maxConnectionPages, ReadBudgetExhausted } from "../plugins/github/pages.ts";

const repo = "alpha/example";
const job = (number: number, attempt = 2) => ({
  run_id: 400,
  run_attempt: attempt,
  check_run_url: `https://api.github.com/repos/Alpha/Example/check-runs/${number}`,
});

test("a connection hitting its safety cap retains evidence but reports partial coverage", async () => {
  const nodePage = (number: number) => ({
    totalCount: maxConnectionPages + 1,
    nodes: [{ id: String(number) }],
    pageInfo: { hasNextPage: true, endCursor: String(number) },
  });
  const result = await cursorPages(nodePage(1), async (cursor) => ({ page: nodePage(Number(cursor) + 1) }));
  assert.equal(result.gap, "truncated");
  assert.equal(result.value?.nodes.length, maxConnectionPages);
});

test("Actions Jobs reads subsequent pages before looking up checks from both attempts", async () => {
  const calls: number[] = [];
  const result = await readAttempts(repo, 400, 2, async (page) => {
    calls.push(page);
    return {
      total_count: 101,
      jobs: page === 1 ? Array.from({ length: 100 }, (_, index) => job(index + 1, 1)) : [job(101)],
    };
  });
  assert.deepEqual(calls, [1, 2]);
  assert.ok(result instanceof Map);
  assert.deepEqual([result.get(1), result.get(101)], [1, 2]);
});

test("CI jobs with a different scope, duplicate ID or drift fail instead of guessing", async () => {
  for (const jobs of [
    [{ ...job(1), run_id: 999 }],
    [{ ...job(1), run_attempt: 3 }],
    [{ ...job(1), check_run_url: "https://api.github.com/repos/other/repo/check-runs/1" }],
    [job(1), job(1, 1)],
  ]) {
    const result = await readAttempts(repo, 400, 2, async () => ({ total_count: jobs.length, jobs }));
    assert.deepEqual(result, { gap: "invalid-response" });
  }
  const drift = await readAttempts(repo, 400, 2, async (page) =>
    page === 1
      ? { total_count: 101, jobs: Array.from({ length: 100 }, (_, index) => job(index + 1)) }
      : { total_count: 102, jobs: [job(101), job(102)] },
  );
  assert.deepEqual(drift, { gap: "invalid-response" });
  assert.deepEqual(await readAttempts(repo, 400, 2, async () => ({ total_count: 2, jobs: [job(1)] })), {
    gap: "invalid-response",
  });
});

test("Jobs surfaces an exhausted budget and stops at its own page limit", async () => {
  assert.deepEqual(
    await readAttempts(repo, 400, 2, async () => {
      throw new ReadBudgetExhausted();
    }),
    { gap: "budget-exhausted" },
  );
  const result = await readAttempts(repo, 400, 2, async (page) => ({
    total_count: maxJobPages * 100 + 1,
    jobs: Array.from({ length: 100 }, (_, index) => job((page - 1) * 100 + index + 1)),
  }));
  assert.deepEqual(result, { gap: "truncated" });
});
