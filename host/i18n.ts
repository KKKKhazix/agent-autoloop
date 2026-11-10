// The interface language. Every human-facing string in the code stays the Chinese it was written in, and t() looks it
// up in locales/<lang>.json: the Chinese string is the key. A string the active dictionary doesn't have is shown as the
// Chinese original, so a dictionary that trails a code change degrades to today's behaviour instead of breaking. The
// language comes from AGENT_AUTOLOOP_LANG first (one-off runs, tests), then config.json's "lang", defaulting to Chinese,
// which needs no dictionary at all. Loading is lazy and cached per process: a CLI command runs once, the hub and the
// worker read the file once. The config file is found the way home.ts lays it out, but read here and not through config.ts:
// importing t() must not drag the install's home into module load — tests point AGENT_AUTOLOOP_HOME somewhere of their own
// only after their imports have run.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function configFile() {
  const home = path.resolve(process.env.AGENT_AUTOLOOP_HOME ?? path.join(homedir(), ".agent-autoloop"));
  return path.join(home, "config.json");
}

let cachedLang: string | null = null;
const dictionaries = new Map<string, Record<string, string>>();

/** Which language the interface speaks: the env var wins over config.json, and an unknown value means Chinese. */
export function currentLang(): string {
  if (cachedLang === null) {
    const env = process.env.AGENT_AUTOLOOP_LANG;
    if (env === "en" || env === "zh") cachedLang = env;
    else {
      try {
        if ((JSON.parse(readFileSync(configFile(), "utf8")) as { lang?: string }).lang === "en") cachedLang = "en";
      } catch {} // not installed yet, no config.json: Chinese
      cachedLang ??= "zh";
    }
  }
  return cachedLang;
}

/** The BCP 47 tag of the active language, for toLocaleString and friends: Chinese formats Chinese, anything else English. */
export function localeTag(): string {
  return currentLang() === "zh" ? "zh-CN" : "en-US";
}

/** For tests, and for changing the language in a long-lived process: forget the language and every dictionary. */
export function resetLang() {
  cachedLang = null;
  dictionaries.clear();
}

/** Test hook: hand a dictionary to a language without touching the filesystem. */
export function seedLocale(lang: string, dictionary: Record<string, string>) {
  dictionaries.set(lang, dictionary);
}

function dictionary(): Record<string, string> {
  const lang = currentLang();
  let dict = dictionaries.get(lang);
  if (!dict) {
    dict = {};
    if (lang !== "zh") {
      const file = path.join(import.meta.dirname, "..", "locales", `${lang}.json`);
      if (existsSync(file)) {
        try {
          dict = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
        } catch {} // a broken locale file means Chinese, not a crash
      }
    }
    dictionaries.set(lang, dict);
  }
  return dict;
}

/** The translation of a Chinese string, with {"name"} replaced from params and {"name|one|other"} picking a form by the
 * English plural (1 → one). A string, a dictionary or a param the lookup doesn't know passes through as-is. */
export function t(zh: string, params?: Record<string, unknown>): string {
  let text = dictionary()[zh] ?? zh;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      const open = `{"${name}|`;
      for (let at = text.indexOf(open); at !== -1; at = text.indexOf(open, at)) {
        const end = text.indexOf("}", at);
        if (end === -1) break;
        // The token closes with a quote before the brace: {"m|one|other"}.
        const forms = text.slice(at + open.length, end - 1).split("|");
        text = text.slice(0, at) + (Number(value) === 1 ? forms[0] : (forms[1] ?? forms[0])) + text.slice(end + 1);
      }
      text = text.replaceAll(`{"${name}"}`, String(value));
    }
  }
  return text;
}
