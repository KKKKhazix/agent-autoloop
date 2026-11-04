// `agent-autoloop uninstall`: takes away what the install put on this computer and nothing else. A link is ours only if it really
// leads to this program: someone else's agent-autoloop, or a folder of their own by that name, stays where it is.
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { HOME } from "../host/home.ts";
import { WINDOWS } from "../host/platform.ts";
import { removeService, stopUp } from "../host/service.ts";

const ROOT = path.join(import.meta.dirname, "..");

function removeLink(link: string, target: string) {
  if (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) return;
  try {
    if (realpathSync(link) !== realpathSync(target)) return;
  } catch {
    return; // It leads nowhere, so not here.
  }
  rmSync(link);
  console.log(`删掉了 ${link}`);
}

/** On Windows the name is a shim file, not a link: it's ours only if its text runs this program. */
function removeShim(file: string, program: string) {
  if (!existsSync(file)) return;
  try {
    if (!readFileSync(file, "utf8").includes(program)) return;
  } catch {
    return;
  }
  rmSync(file, { force: true });
  console.log(`删掉了 ${file}`);
}

function removeLinks() {
  const program = path.join(ROOT, "bin", "agent-autoloop.ts");
  const onPath = (process.env.PATH ?? "").split(path.delimiter).filter((place) => path.isAbsolute(place));
  const places = [path.join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", ...onPath];
  for (const place of new Set(places)) {
    removeLink(path.join(place, "agent-autoloop"), program);
    if (WINDOWS)
      for (const ext of [".cmd", ".bat", ".ps1"]) removeShim(path.join(place, `agent-autoloop${ext}`), program);
  }
  const skill = path.join(ROOT, "skills", "agent-autoloop");
  for (const agent of [".claude", ".codex"]) removeLink(path.join(homedir(), agent, "skills", "agent-autoloop"), skill);
}

/** Confirmation is about removing the program; data is never part of this command. */
export async function uninstall(yes: boolean, ask: ((question: string) => Promise<string>) | null) {
  if (!yes) {
    if (!ask) throw new Error("运行 agent-autoloop uninstall --yes 卸载程序，规则、密钥和记录会保留。");
    if (!/^y(es)?$/i.test((await ask("卸载程序并保留数据？[y/N] ")).trim())) {
      console.log("没有卸载。");
      return;
    }
  }
  removeService();
  stopUp();
  removeLinks();
  const installedApp = path.join(HOME, "app");
  if (existsSync(installedApp) && realpathSync(installedApp) === realpathSync(ROOT)) {
    rmSync(installedApp, { recursive: true });
  }
  console.log(existsSync(HOME) ? `卸载好了。规则、密钥和记录还留在 ${HOME}。` : "卸载好了。");
}
