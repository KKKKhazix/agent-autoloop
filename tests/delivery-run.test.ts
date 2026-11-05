// Failure modes: an owner question with backticks in its title or text cuts the receipt short.
// Nothing here reaches GitHub: `gh` is a stand-in first on PATH, and the Git remote is a local folder.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { run } from "../plugins/delivery/run.ts";
import { readMessage } from "../worker/contract.ts";

const root = mkdtempSync(join(tmpdir(), "agent-autoloop-delivery-run-"));
after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, "bin");
const routes = join(root, "routes.json");
const calls = join(root, "calls.txt");
mkdirSync(bin);
writeFileSync(
  join(bin, "gh"),
  `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_CALLS, args.join(" ") + "\\n");
const answer = JSON.parse(readFileSync(process.env.FAKE_GH_ROUTES, "utf8"))[args[1]];
if (answer === undefined || answer.fail) {
  console.error(answer?.fail ?? "gh: Not Found (HTTP 404)");
  process.exit(1);
}
console.log(JSON.stringify(args.includes("--slurp") ? [answer] : answer));
`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FAKE_GH_ROUTES = routes;
process.env.FAKE_GH_CALLS = calls;
/** What the stand-in answers from here on, by the path after `gh api`, and a clean list of what it was asked. */
const answers = (table: object) => {
  writeFileSync(routes, JSON.stringify(table));
  writeFileSync(calls, "");
};
const issue = (number: number, fields: object = {}) => ({
  number,
  state: "open",
  title: "需要决定",
  body: "请决定",
  html_url: `https://github.com/example/app/issues/${number}`,
  labels: [{ name: "ask-owner" }],
  ...fields,
});
const about = (number: number) => ({ events: [{ subject: `example/app#${number}` }] });

test("an owner question with backticks reaches the hub whole", async () => {
  const title = "```标题";
  answers({ "repos/example/app/issues/5": issue(5, { title, body: "还有\n```\n没收尾的代码块" }) });
  const { problem, receipt } = readMessage(await run("example/app", about(5)));
  assert.equal(problem, undefined);
  const [card] = (receipt as any).ask;
  assert.equal(card.title, title);
  assert.match(card.text, /没收尾的代码块/);
});
