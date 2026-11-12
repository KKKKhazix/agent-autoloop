// Failure modes: transcript requests use the wrong contract, missing keys reach the network,
// or asynchronous/provider failures are mistaken for a transcript.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { transcript } from "../examples/recipes/monid-transcript/collect.ts";

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.MONID_API_KEY;
  process.env.MONID_API_KEY = "test-key";
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.MONID_API_KEY;
  else process.env.MONID_API_KEY = savedKey;
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("Monid transcript sends the documented request and returns AgentLine data", async () => {
  const output = { status: "completed", turns: [{ role: "human", text: "你好", timestamp: 0 }] };
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, "https://api.monid.ai/v1/run");
    assert.equal(options?.method, "POST");
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer test-key");
    assert.deepEqual(JSON.parse(String(options?.body)), {
      provider: "agentline",
      endpoint: "/calls/{id}/transcript",
      input: { body: { numberId: "number-1", callId: "call-1" } },
    });
    return json({ output });
  };
  assert.deepEqual(await transcript("number-1", "call-1", request), output);
});

test("Monid transcript refuses a missing key before any request", async () => {
  delete process.env.MONID_API_KEY;
  await assert.rejects(
    transcript("number-1", "call-1", async () => assert.fail("unexpected request")),
    /请先设置 MONID_API_KEY/,
  );
});

test("Monid transcript polls the original run until completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const request: typeof fetch = async (url, options) => {
    calls++;
    if (calls === 1) return json({ runId: "run-1" }, 202);
    assert.equal(url, "https://api.monid.ai/v1/runs/run-1");
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer test-key");
    return calls === 2 ? json({ status: "RUNNING" }) : json({ status: "COMPLETED", output: { turns: [] } });
  };
  const pending = transcript("number-1", "call-1", request);
  for (let i = 0; i < 4; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(2000);
  }
  assert.deepEqual(await pending, { turns: [] });
  assert.equal(calls, 3);
});

test("Monid transcript preserves AgentLine errors instead of returning missing output", async () => {
  await assert.rejects(
    transcript("number-1", "call-1", async () =>
      json({ status: "COMPLETED", providerResponse: { httpStatus: 404, error: { message: "no match" } } }),
    ),
    (error: Error & { status?: number; error?: unknown }) => {
      assert.equal(error.status, 404);
      assert.deepEqual(error.error, { message: "no match" });
      assert.match(error.message, /AgentLine 404/);
      return true;
    },
  );
});

for (const status of ["FAILED", "TIMED_OUT", "STOPPED", "BLOCKED"]) {
  test(`Monid transcript rejects terminal state ${status}`, async () => {
    await assert.rejects(
      transcript("number-1", "call-1", async () => json({ status })),
      new RegExp(status),
    );
  });
}

test("Monid transcript reports HTTP errors on submission and polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await assert.rejects(
    transcript("number-1", "call-1", async () => json({ message: "bad key" }, 401)),
    /Monid 401.*bad key/,
  );
  let calls = 0;
  const pending = transcript("number-1", "call-1", async () =>
    ++calls === 1 ? json({ runId: "run-1" }, 202) : json({ message: "unavailable" }, 503),
  );
  const checked = assert.rejects(pending, /Monid 503.*unavailable/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(2000);
  await checked;
});
