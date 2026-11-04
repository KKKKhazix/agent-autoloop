// 防止什么失败：try 一开始就把上一次留下、仍停在 queued + attempts>0 的 run 当成这一次的失败，
// 或者把上一轮遗留的试跑卡片当成这一次的问题，于是正常的一轮被报成「Agent 没跑成」，
// 或者把答案提交到上一轮的卡片上。run 一旦 attempt 过就回到 queued 等待回答，这是续跑的正常
// 中间态而不是异常，所以判定必须只认这一次触发之后新出现的 id。
import assert from "node:assert/strict";
import { test } from "node:test";
import { newAskCard, newFailure, snapshot } from "../cli/try.ts";

const run = (id: number, extra: Partial<Parameters<typeof newFailure>[0][number]> = {}) => ({
  id,
  rule: "试一下",
  state: "queued",
  attempts: 1,
  error: "",
  ...extra,
});

const card = (id: number, extra: Partial<{ kind: string; title: string }> = {}) => ({
  id,
  kind: "ask",
  title: "试跑：选个颜色",
  ...extra,
});

test("之前的 run 仍停在 queued + attempts>0 时不算这一次的失败", () => {
  assert.equal(newFailure([run(1)], snapshot([{ id: 1 }])), null);
});

test("不做快照（等同于不按 id 过滤的旧写法）时，历史 run 会被误判成失败", () => {
  // 这条复现原来的行为：find 不带 id 条件，任何 attempts>0 的 queued run 都会命中。
  assert.equal(newFailure([run(1)], new Set())?.id, 1);
});

test("这一次新出现的失败 run 会被抓到", () => {
  const failed = newFailure([run(1), run(9, { error: "agent 起不来" })], snapshot([{ id: 1 }]));
  assert.equal(failed?.id, 9);
  assert.equal(failed?.error, "agent 起不来");
});

test("其他规则、已完成、还没试过的 run 都不算失败", () => {
  const seen = snapshot([]);
  assert.equal(newFailure([run(2, { rule: "别的" })], seen), null);
  assert.equal(newFailure([run(3, { state: "done" })], seen), null);
  assert.equal(newFailure([run(4, { attempts: 0 })], seen), null);
});

test("上一轮遗留的试跑卡片不会被当成这一次的问题", () => {
  assert.equal(newAskCard([card(5)], snapshot([{ id: 5 }])), null);
});

test("这一次新出现的试跑卡片会被拿到", () => {
  const picked = newAskCard([card(5), card(8)], snapshot([{ id: 5 }]));
  assert.equal(picked?.id, 8);
});

test("非试跑、非提问类卡片不会被当成这一次的问题", () => {
  const seen = snapshot([]);
  assert.equal(newAskCard([card(6, { kind: "notice" })], seen), null);
  assert.equal(newAskCard([card(7, { title: "别的" })], seen), null);
});

test("state() 里没有 runs 或 cards 时快照为空，不影响首次运行", () => {
  assert.equal(snapshot(undefined).size, 0);
  assert.equal(newFailure([run(10)], snapshot(undefined))?.id, 10);
});
