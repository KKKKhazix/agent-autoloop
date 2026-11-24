// Opening the one link that carries this run's session. The URL is always printed too: a browser that refuses to start
// must not stop the console.
import { spawn } from "node:child_process";

export function openBrowser(url) {
  if (process.env.AGENT_AUTOLOOP_WEB_NO_BROWSER === "1") return;
  const [program, args] =
    process.platform === "win32"
      ? ["explorer.exe", [url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(program, args, { stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}
