// A stale browser tab or an invalid draft must never replace the user's working rules.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("rules are checked natively and saved against the version that was edited", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "autoloop-web-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  process.env.AGENT_AUTOLOOP_HOME = home;
  process.env.AGENT_AUTOLOOP_RULES = join(home, "rules.json");
  const { ruleFile, saveRules } = await import("../server/settings.mjs");
  const original = JSON.stringify({ sources: {}, agents: {}, rules: [] });
  writeFileSync(process.env.AGENT_AUTOLOOP_RULES, original);
  const { revision } = ruleFile();
  assert.throws(() => saveRules({ text: "{}", revision }), /rules.json/);
  assert.equal(readFileSync(process.env.AGENT_AUTOLOOP_RULES, "utf8"), original);
  const edited = original.replace('"rules"', '"timezone":"UTC","rules"');
  saveRules({ text: edited, revision });
  assert.throws(() => saveRules({ text: original, revision }), /重新读取/);
  assert.deepEqual(JSON.parse(ruleFile().text), JSON.parse(edited));
});
