// The i18n core. A string the dictionary doesn't have must fall back to the Chinese original rather than break, {"name"}
// placeholders must take their values, {"name|one|other"} must pick the English plural (1 → one), and the language must
// come from AGENT_AUTOLOOP_LANG ahead of the default. Everything runs in a home of its own so the machine's real
// config.json can't decide what the test sees.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "agent-autoloop-i18n-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const wasLang = process.env.AGENT_AUTOLOOP_LANG;
after(() => {
  if (wasLang === undefined) delete process.env.AGENT_AUTOLOOP_LANG;
  else process.env.AGENT_AUTOLOOP_LANG = wasLang;
});

// The home has to be set before the first import: home.ts reads the env var once, at load time.
process.env.AGENT_AUTOLOOP_HOME = dir;
delete process.env.AGENT_AUTOLOOP_LANG;
const { currentLang, resetLang, seedLocale, t } = await import("../host/i18n.ts");

test("a string the dictionary lacks stays Chinese", () => {
  resetLang();
  assert.equal(currentLang(), "zh");
  assert.equal(t("还没有这个东西"), "还没有这个东西");
});

test('the active dictionary translates, {"name"} takes a value', () => {
  resetLang();
  seedLocale("zh", { '做了 {"n"} 件事': 'did {"n"} things' });
  assert.equal(t('做了 {"n"} 件事', { n: 5 }), "did 5 things");
  // A param the dictionary line doesn't use is ignored; a param the line needs but nobody gave stays visible.
  assert.equal(t('做了 {"n"} 件事'), 'did {"n"} things');
});

test('{"name|one|other"} picks the English plural', () => {
  resetLang();
  // The number and the pluralised word are separate placeholders: {"m"} renders the value, {"m|..."} the word.
  seedLocale("zh", { '花了 {"m"} 分钟': 'took {"m"} {"m|minute|minutes"}' });
  assert.equal(t('花了 {"m"} 分钟', { m: 1 }), "took 1 minute");
  assert.equal(t('花了 {"m"} 分钟', { m: 90 }), "took 90 minutes");
  // Not a number: the other form, and no crash.
  assert.equal(t('花了 {"m"} 分钟', { m: "час" }), "took час minutes");
});

test("the language switches per process and unknown values mean Chinese", () => {
  resetLang();
  seedLocale("en", { 做完了: "done" });
  process.env.AGENT_AUTOLOOP_LANG = "en";
  assert.equal(currentLang(), "en");
  assert.equal(t("做完了"), "done");
  process.env.AGENT_AUTOLOOP_LANG = "ru";
  resetLang();
  assert.equal(currentLang(), "zh"); // no ru dictionary yet: Chinese
  delete process.env.AGENT_AUTOLOOP_LANG;
  resetLang();
  assert.equal(currentLang(), "zh");
});
