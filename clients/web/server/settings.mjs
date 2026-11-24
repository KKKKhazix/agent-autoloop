import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { HOME, RULES_FILE } from "../../../host/home.ts";
import { CONFIG_FILE, parseListen, readConfig, writeConfig } from "../../../host/config.ts";
import { parseRules } from "../../../protocol/rules.ts";

const digest = (text) => createHash("sha256").update(text).digest("hex");
export const checkRules = (text) => parseRules(text, Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);

export function ruleFile() {
  const text = readFileSync(RULES_FILE, "utf8");
  let problem;
  try {
    checkRules(text);
  } catch (e) {
    problem = e.message;
  }
  return { text, revision: digest(text), problem };
}

function current(expected, actual) {
  if (expected !== actual) throw Object.assign(new Error("文件已经变化，请重新读取后再编辑。"), { status: 409 });
}

export function saveRules({ text, revision }) {
  checkRules(text);
  const file = realpathSync(RULES_FILE);
  current(revision, ruleFile().revision);
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } finally {
    rmSync(temp, { force: true });
  }
  return ruleFile();
}

export function localSettings() {
  const config = readConfig();
  const plugins = new Map();
  for (const [base, builtin] of [
    [resolve(import.meta.dirname, "../../../plugins"), true],
    [join(HOME, "plugins"), false],
  ]) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      if (/^[a-z][a-z0-9-]*$/.test(name) && existsSync(join(base, name, "agent.ts")))
        plugins.set(name, { name, builtin });
    }
  }
  return {
    home: HOME,
    rulesPath: RULES_FILE,
    configPath: CONFIG_FILE,
    url: config.url,
    hub: config.hub,
    owner: Boolean(config.owner),
    source: config.source?.name,
    worker: config.worker && {
      name: config.worker.name,
      capacity: config.worker.capacity,
      unreachable: config.worker.unreachable,
    },
    channels: Object.keys(config.channels ?? {}),
    plugins: [...plugins.values()],
    revision: digest(readFileSync(CONFIG_FILE)),
  };
}

function httpUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("请填写不含凭据、查询参数或片段的 HTTP(S) 地址");
  return value;
}

export function saveConnection({ revision, url, listen, publicUrl }) {
  const config = readConfig();
  current(revision, digest(readFileSync(CONFIG_FILE)));
  config.url = httpUrl(url);
  if (config.hub) {
    parseListen(listen);
    config.hub.listen = listen;
    if (publicUrl) config.hub.publicUrl = httpUrl(publicUrl);
    else delete config.hub.publicUrl;
  }
  writeConfig(config);
  return { ok: true };
}

export function saveWorker({ revision, capacity, unreachable }) {
  const config = readConfig();
  current(revision, digest(readFileSync(CONFIG_FILE)));
  if (!config.worker) throw new Error("本机没有配置 Worker");
  if (capacity !== null && (!Number.isSafeInteger(capacity) || capacity < 1)) throw new Error("并发数需要正整数");
  if (!Array.isArray(unreachable) || !unreachable.every((item) => typeof item === "string"))
    throw new Error("通知命令应为参数列表");
  if (capacity === null) delete config.worker.capacity;
  else config.worker.capacity = capacity;
  config.worker.unreachable = unreachable;
  writeConfig(config);
  return localSettings();
}
