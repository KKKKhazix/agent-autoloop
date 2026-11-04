// GitLab webhook source: real-payload handling and idempotency across retries.
import assert from "node:assert/strict";
import { test } from "node:test";
import gitlab from "../plugins/gitlab/source.ts";

const secret = "test-secret";
const headers = (extra: Record<string, string> = {}) => ({
  "x-gitlab-token": secret,
  "idempotency-key": "evt-12345",
  ...extra,
} as Record<string, string | string[] | undefined>);

const mergeRequestOpen = {
  object_kind: "merge_request",
  object_attributes: {
    id: 98765,
    iid: 42,
    action: "open",
    title: "Fix login flow",
    url: "https://gitlab.com/org/proj/merge_requests/42",
    description: "Fixes the login flow for mobile.",
  },
  project: {
    full_name: "org/proj",
    path_with_namespace: "org/proj",
    name: "proj",
    web_url: "https://gitlab.com/org/proj",
  },
};

test("gitlab: merge_request.open yields type merge_request.open", () => {
  const out = gitlab({ headers: headers(), body: JSON.stringify(mergeRequestOpen), secret });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "merge_request.open");
  assert.equal(out[0].subject, "org/proj#42");
  assert.equal(out[0].summary, "Fix login flow");
  assert.equal(out[0].id, "evt-12345");
});

test("gitlab: retry with same Idempotency-Key yields same id", () => {
  const first = gitlab({ headers: headers(), body: JSON.stringify(mergeRequestOpen), secret });
  const second = gitlab({ headers: headers(), body: JSON.stringify(mergeRequestOpen), secret });
  assert.equal(first[0].id, second[0].id);
});

test("gitlab: no Idempotency-Key falls back to stable payload id, not random", () => {
  const noKey = { ...headers(), "idempotency-key": undefined };
  const first = gitlab({ headers: noKey, body: JSON.stringify(mergeRequestOpen), secret });
  const second = gitlab({ headers: noKey, body: JSON.stringify(mergeRequestOpen), secret });
  assert.equal(first[0].id, "98765");
  assert.equal(first[0].id, second[0].id);
});

test("gitlab: missing token throws", () => {
  assert.throws(() =>
    gitlab({ headers: { "x-gitlab-token": "wrong" }, body: JSON.stringify(mergeRequestOpen), secret })
  );
});

test("gitlab: ping returns empty", () => {
  const out = gitlab({
    headers: { ...headers(), "x-gitlab-event": "ping" },
    body: JSON.stringify(mergeRequestOpen),
    secret,
  });
  assert.deepEqual(out, []);
});
