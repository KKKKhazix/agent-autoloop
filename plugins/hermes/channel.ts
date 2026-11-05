// Anywhere Hermes can already send. The same `hermes send` a script uses reaches iMessage, WeChat and Telegram with
// the credentials the gateway already holds, so a card needs no separate account of its own.
// Words and a link, no buttons: pair it with "links": true in rules.json so the link itself answers that one card.
//   "channels": { "imessage": { "use": "hermes", "target": "photon", "links": true },
//                 "wechat": { "use": "hermes", "target": "weixin" } }
// A target is whatever `hermes send --list` printed: a bare platform for its home chat, or platform:chat_id.
import { spawn } from "node:child_process";
import type { Card, ChannelContext } from "../../host/channels.ts";
import { findProgram } from "../../worker/agents.ts";

/** Sends a message as its own program would, with the words on stdin so nothing has to fit in an argument. */
function send(program: string, args: string[], input: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `${program} exited with ${code}`)),
    );
    child.stdin.end(input);
  });
}
/** Chats cut long messages; what is left of one is better than a send that fails. */
const BODY_MAX = 3500;

function words(card: Card) {
  const choices = card.options.map((option, index) => `${index + 1}. ${option}`).join("\n");
  const parts = [card.text, ...(card.state === "open" ? [choices, card.link] : [])];
  const body = parts.filter(Boolean).join("\n\n");
  return [...body].length > BODY_MAX ? `${[...body].slice(0, BODY_MAX).join("")}…` : body;
}

export default async function hermes({ hub, options, log, signal }: ChannelContext) {
  const target = String(options.target ?? "").trim();
  if (!target) throw new Error("the hermes channel needs a target: what `hermes send --list` calls it");
  // Heard through a login shell, the same way an agent is found: a launchd PATH is smaller than a person's.
  const program = options.program ? String(options.program) : findProgram("hermes");
  while (!signal.aborted) {
    let card: Card | null;
    try {
      ({ card } = await hub.nextCard(50));
    } catch (error) {
      log(`couldn't reach the hub: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    if (!card) continue;
    // A message already sent is not sent again: a chat cannot edit it, so an update has nothing to do.
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    try {
      await send(program, ["send", "--to", target, "--subject", card.title, "-"], words(card) || card.title);
      // Shutting down is not the card's failure: the person just didn't hear about this one.
      if (signal.aborted) return;
      await hub.delivered(card.id, card.version, `hermes-${card.id}`);
    } catch (error) {
      if (signal.aborted) return;
      log(`card ${card.id} not sent: ${error}`);
      await hub.failed(card.id, card.version, String(error)).catch(() => {});
    }
  }
}
