// The deploy round: read ops/deploy.json from the project, ask the owner when the config says so, run the publish
// command, then poll the probe until the live version is the one we shipped. Prints only the final word on stdout;
// probe attempts go to stderr. Exit 0 means the round said its piece (asked, cancelled or verified); exit non-zero
// means the round failed and the hub may re-run it, so the publish command must be safe to run again.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const SETTINGS = join("ops", "deploy.json");
const ASK_KEY = "deploy";
const INTERVAL_SECONDS = 2;
const DEFAULT_DEADLINE = 600;

const tail = (text: string, length = 300) => text.trim().slice(-length);

const run = (argv: string[]) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(argv[0], argv.slice(1), { timeout: 3_600_000 }, (error, stdout, stderr) => {
      // A signal kill and a plain non-zero exit both land in `error`; what matters for the word we print is the code.
      const code = error && "code" in error && typeof error.code === "number" ? error.code : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

type Probe = { kind: "command"; command: string[] } | { kind: "url"; url: string; field?: string; pattern?: string };

type Settings = {
  command: string[];
  version: string[];
  probe: Probe;
  deadline: number;
  confirm: boolean;
};

const isWords = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part.trim() !== "");

function fail(word: string): never {
  console.log(`没跑成：${word}`);
  process.exit(1);
}

function load(): Settings {
  let raw: string;
  try {
    raw = readFileSync(SETTINGS, "utf8");
  } catch {
    fail(`这个项目没有 ${SETTINGS}：在里面写清发布命令（command）、期望版本命令（version）和线上探活（probe）`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    fail(`${SETTINGS} 不是 JSON：${(error as Error).message}`);
  }
  const where = (name: string) => `${SETTINGS} 的 ${name} `;
  const check = (ok: boolean, name: string, problem: string): void => {
    if (!ok) fail(`${where(name)}${problem}`);
  };
  const root = json as Record<string, unknown>;
  check(isWords(root.command), "command", "要是命令行的列表");
  check(isWords(root.version), "version", "要是命令行的列表");
  const probe = root.probe as Record<string, unknown>;
  check(typeof probe === "object" && probe !== null, "probe", '要写成 {"command": […]} 或 {"url": "…"}');
  let parsed: Probe;
  if (isWords(probe.command)) {
    parsed = { kind: "command", command: probe.command };
  } else if (typeof probe.url === "string" && probe.url.trim() !== "") {
    const url = new URL(probe.url); // throws for a malformed one; caught by the caller's try
    const local = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
    check(url.protocol === "https:" || local, "probe.url", "只支持 https，本机测试可以用 http://127.0.0.1");
    check(probe.field === undefined || typeof probe.field === "string", "probe.field", "要是文字");
    check(probe.pattern === undefined || typeof probe.pattern === "string", "probe.pattern", "要是文字");
    parsed = {
      kind: "url",
      url: probe.url,
      field: probe.field as string | undefined,
      pattern: probe.pattern as string | undefined,
    };
  } else {
    fail(`${where("probe")}要写成 {"command": […]} 或 {"url": "…"}`);
  }
  const deadline = root.deadline ?? DEFAULT_DEADLINE;
  check(Number.isInteger(deadline) && (deadline as number) > 0, "deadline", "要是正整数（秒）");
  const confirm = root.confirm ?? false;
  check(typeof confirm === "boolean", "confirm", "要是 true 或 false");
  for (const name of Object.keys(root)) {
    if (!["command", "version", "probe", "deadline", "confirm"].includes(name))
      fail(`${SETTINGS} 有不认识的字段 ${name}`);
  }
  return {
    command: root.command as string[],
    version: root.version as string[],
    probe: parsed,
    deadline: deadline as number,
    confirm: confirm as boolean,
  };
}

/** The answer to this thread's deploy question, if the owner has answered it. Cards don't carry the ask key (`about`
 *  is for timers), so the round's own title names the question. */
function decision(title: string) {
  try {
    const context = JSON.parse(readFileSync(process.env.AGENT_AUTOLOOP_CONTEXT!, "utf8"));
    const answers = Array.isArray(context.answers) ? context.answers : [];
    return answers.find(
      (answer: { title?: string; chosen?: string | null; choice?: number | null }) =>
        answer?.title === title && (answer.chosen != null || answer.choice != null),
    ) as { chosen: string | null } | undefined;
  } catch {
    return undefined;
  }
}

async function probeOnce(probe: Probe, expected: string): Promise<string> {
  if (probe.kind === "command") {
    // The expected version is the last argument, for probes that verify a server-side file against it.
    const done = await run([...probe.command, expected]);
    if (done.code !== 0) return `探活命令退出码 ${done.code}：${tail(done.stderr || done.stdout) || "没留下原因"}`;
    return done.stdout.trim();
  }
  let response: Response;
  try {
    response = await fetch(probe.url, { signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    return `HTTP ${(error as Error).message}`;
  }
  if (!response.ok) return `HTTP ${response.status}`;
  const body = await response.text();
  if (probe.field !== undefined) {
    try {
      let value: unknown = JSON.parse(body);
      for (const part of probe.field.split(".")) value = (value as Record<string, unknown>)[part];
      return value === undefined ? `JSON 里没有 ${probe.field}` : String(value).trim();
    } catch {
      return "不是 JSON";
    }
  }
  if (probe.pattern !== undefined) {
    const match = new RegExp(probe.pattern).exec(body);
    return match ? (match[1] ?? match[0]).trim() : `没有匹配 ${probe.pattern}`;
  }
  return body.trim();
}

const main = async () => {
  let settings: Settings;
  try {
    settings = load();
  } catch (error) {
    // A malformed probe URL throws out of `load`; everything else fails with its own word.
    fail(`${SETTINGS} ${(error as Error).message}`);
  }
  const name = basename(process.cwd());
  const title = `发布 ${name}`;

  const version = await run(settings.version);
  if (version.code !== 0)
    fail(`版本命令退出码 ${version.code}：${tail(version.stderr || version.stdout) || "没留下原因"}`);
  const expected = version.stdout.trim();

  if (settings.confirm) {
    const answer = decision(title);
    if (!answer) {
      const ask = {
        ask: [{ title, text: `把 ${name} 的 ${expected} 发布到线上并核实。`, options: ["发布", "取消"], key: ASK_KEY }],
      };
      console.log(
        `待确认：是否把 ${name} 的 ${expected} 发布到线上？\n\n\`\`\`agent-autoloop\n${JSON.stringify(ask)}\n\`\`\``,
      );
      return;
    }
    if (answer.chosen === "取消") {
      console.log(`已取消发布：${name} 维持线上现状`);
      return;
    }
  }

  const publish = await run(settings.command);
  if (publish.code !== 0)
    fail(`发布命令退出码 ${publish.code}：${tail(publish.stderr || publish.stdout) || "没留下原因"}`);

  let observed = "";
  const started = Date.now();
  for (;;) {
    observed = await probeOnce(settings.probe, expected);
    console.error(`probe：期望「${expected}」线上「${observed}」`);
    if (observed === expected) {
      console.log(`发布完成：线上版本已核实为 ${expected}`);
      return;
    }
    if ((Date.now() - started) / 1000 >= settings.deadline) {
      fail(`发布命令已执行，等了 ${settings.deadline} 秒线上版本仍是「${observed}」，期望「${expected}」`);
    }
    await sleep(INTERVAL_SECONDS * 1000);
  }
};

main();
