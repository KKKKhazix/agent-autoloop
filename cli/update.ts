// `agent-autoloop update`: what came from the public repository follows its releases, which have passed every check, not main,
// which may not have yet. A copy from anywhere else follows that place. install.sh decides the same way, or an update would
// fail on a copy it had moved.
import { spawnSync } from "node:child_process";

const PUBLISHED = "https://github.com/KKKKhazix/agent-autoloop.git";
const RELEASE = /refs\/tags\/(v(\d+)\.(\d+)\.(\d+))$/;
/** How long one git call may take before the command fails instead of hanging with no answer. */
const GIT_TIMEOUT = 60_000;

const timedOut = (error: NodeJS.ErrnoException | undefined) => error?.code === "ETIMEDOUT";

function git(root: string, args: string[], timeout = GIT_TIMEOUT) {
  const done = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout });
  if (done.status !== 0) {
    const reason = timedOut(done.error as NodeJS.ErrnoException) ? "超时" : done.stderr?.trim() || done.error?.message;
    throw new Error(`git ${args[0]} 没成功：${reason}`);
  }
  return done.stdout.trim();
}

function latestRelease(root: string, timeout = GIT_TIMEOUT) {
  const origin = spawnSync("git", ["-C", root, "config", "--get", "remote.origin.url"], { encoding: "utf8", timeout });
  if (timedOut(origin.error as NodeJS.ErrnoException)) throw new Error("git config 没成功：超时");
  if (origin.stdout?.trim() !== PUBLISHED) return null;
  const releases = git(root, ["ls-remote", "--refs", "--tags", "origin", "v*"], timeout)
    .split("\n")
    .flatMap((line) => {
      const found = RELEASE.exec(line);
      return found ? [{ tag: found[1], version: found.slice(2).map(Number) }] : [];
    });
  const newer = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return releases.sort((a, b) => newer(a.version, b.version)).at(-1)?.tag ?? null;
}

/** Brings this copy up to date. `to` is the release it's now at, if it follows releases. */
export function updateCode(root: string, timeout = GIT_TIMEOUT) {
  const before = git(root, ["rev-parse", "HEAD"], timeout);
  const to = latestRelease(root, timeout);
  if (to) {
    git(root, ["fetch", "--quiet", "--depth", "1", "origin", `refs/tags/${to}:refs/tags/${to}`], timeout);
    git(root, ["checkout", "--quiet", "--detach", to], timeout);
  } else git(root, ["pull", "--quiet", "--ff-only"], timeout);
  return { changed: git(root, ["rev-parse", "HEAD"], timeout) !== before, to };
}
