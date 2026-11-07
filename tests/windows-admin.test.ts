// Failure modes on Windows: a home written as an 8.3 short name (a TEMP like C:\Users\ADMINI~1\Temp) takes the hub down
// with a libuv assertion the first time its rules folder changes; a hub is taken for one without an administrator's full
// token, or the other way round, so a login task that runs it elevated goes unnoticed or one that doesn't is removed; the
// startup shortcut offered where no login task can be made starts something other than what the task would.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { powershell, psQuote } from "../host/command.ts";

const windows = process.platform === "win32";
const scratch = mkdtempSync(join(tmpdir(), "agent-autoloop-windows-admin-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const short = windows
  ? powershell(`(New-Object -ComObject Scripting.FileSystemObject).GetFolder(${psQuote(scratch)}).ShortPath`)
  : scratch;
process.env.AGENT_AUTOLOOP_HOME = join(short, "home");
process.env.AGENT_AUTOLOOP_RULES = join(short, "home", "rules.json");
process.env.AGENT_AUTOLOOP_PUBLIC_URL = "https://hub.test";
mkdirSync(join(scratch, "home"));
copyFileSync(join(import.meta.dirname, "rules.fixture.json"), join(scratch, "home", "rules.json"));

test(
  "a hub whose home is an 8.3 short name keeps going when its rules folder changes",
  { skip: !windows },
  async (t) => {
    if (short === scratch) return t.skip("this volume has no 8.3 names");
    const { serve } = await import("../host/http.ts");
    const server = serve(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { db } = await import("../host/runtime.ts");
    t.after(() => {
      server.close();
      server.closeAllConnections();
      db.close();
    });
    writeFileSync(join(scratch, "home", "unrelated.txt"), "x");
    copyFileSync(join(import.meta.dirname, "rules.fixture.json"), join(scratch, "home", "rules.json"));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const port = (server.address() as AddressInfo).port;
    assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
  },
);

test("an elevated process is told apart from one that isn't", { skip: !windows }, async () => {
  const { elevated } = await import("../host/service.ts");
  const groups = spawnSync("whoami", ["/groups"], { encoding: "utf8", windowsHide: true }).stdout;
  assert.equal(elevated(process.pid), groups.includes("S-1-16-12288"));
});

test("the startup shortcut runs exactly what the login task runs", { skip: !windows }, async () => {
  const { startupShortcut, windowsLauncher } = await import("../host/service.ts");
  const folder = join(scratch, "启动 ' 文件夹");
  mkdirSync(folder);
  powershell(startupShortcut(psQuote(folder)));
  const shortcut = powershell(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(
    (Get-ChildItem -LiteralPath ${psQuote(folder)} -Filter *.lnk | Select-Object -First 1).FullName)
    @($s.TargetPath, $s.Arguments, $s.WorkingDirectory) -join [char]10`).split("\n");
  const task = windowsLauncher();
  // The shortcut writes C:\Windows with the folder's own capitals, which Windows doesn't care about.
  assert.deepEqual(
    [shortcut[0].toLowerCase(), ...shortcut.slice(1)],
    [task.program.toLowerCase(), task.args, task.directory],
  );
});
