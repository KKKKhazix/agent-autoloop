// Node cannot exec a Windows npm .cmd shim. Run its JavaScript entry directly so multiline arguments never become cmd source.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function commandLine(argv: string[]): [string, string[]] {
  if (process.platform !== "win32") return [argv[0], argv.slice(1)];
  let program = argv[0];
  if (!path.isAbsolute(program)) {
    program =
      execFileSync("where.exe", [program], { encoding: "utf8", windowsHide: true })
        .trim()
        .split(/\r?\n/)
        .find((file) => /\.(exe|com|cmd|bat|ps1)$/i.test(file)) ?? program;
  }
  if (/\.cmd$/i.test(program)) {
    const shim = readFileSync(program, "utf8");
    const entry = /"%(?:dp0%|~dp0)\\?([^"\r\n]+\.(?:[cm]?js))"\s+%\*/i.exec(shim);
    if (!entry) throw new Error(`不能直接运行 ${program}：请在 command 写可执行文件，或用 node 运行脚本。`);
    const adjacentNode = path.join(path.dirname(program), "node.exe");
    return [
      existsSync(adjacentNode) ? adjacentNode : process.execPath,
      [path.resolve(path.dirname(program), entry[1]), ...argv.slice(1)],
    ];
  }
  if (/\.ps1$/i.test(program))
    return ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", program, ...argv.slice(1)]];
  if (/\.bat$/i.test(program))
    throw new Error(`不能直接运行 ${program}：请在 command 写可执行文件，或用 node 运行脚本。`);
  return [program, argv.slice(1)];
}

export function powershell(script: string) {
  return execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(
        "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + script,
        "utf16le",
      ).toString("base64"),
    ],
    { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

export const psQuote = (word: string) => `'${word.replaceAll("'", "''")}'`;

export function processCommand(pid: number) {
  if (process.platform === "win32") {
    return powershell(`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`);
  }
  return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
}
