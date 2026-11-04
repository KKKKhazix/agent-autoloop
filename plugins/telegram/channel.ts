// Telegram channel: sends cards to a Telegram chat via the Bot API.
// Words and a link, with buttons for options: pair it with "links": true in rules.json.
//   "channels": { "telegram": { "use": "telegram", "key": "…", "botToken": "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11", "chatId": "-1001234567890" } }
import type { Card, ChannelContext } from "../../host/channels.ts";

function words(card: Card) {
  const choices = card.options.map((option, index) => `${index + 1}. ${option}`).join("\n");
  const parts = [card.title, card.text, ...(card.state === "open" ? [choices, card.link] : [])];
  return parts.filter(Boolean).join("\n\n");
}

export default async function telegram({ hub, options, log, signal }: ChannelContext) {
  const botToken = String(options.botToken ?? "");
  const chatId = String(options.chatId ?? "");
  if (!botToken || !chatId) {
    log("telegram channel: botToken or chatId not configured");
    return;
  }
  const base = `https://api.telegram.org/bot${botToken}`;
  while (!signal.aborted) {
    let card: Card | null;
    try {
      ({ card } = await hub.nextCard(50));
    } catch (error) {
      log(`telegram: couldn't reach the hub: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      continue;
    }
    if (!card) continue;
    // Can't edit a message once sent: an update has nothing to do.
    if (card.ref) {
      await hub.delivered(card.id, card.version, card.ref);
      continue;
    }
    try {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: words(card),
        parse_mode: "Markdown",
        disable_web_page_preview: false,
      };
      if (card.state === "open" && card.options.length) {
        body["reply_markup"] = {
          inline_keyboard: card.options.map((option, index) => [
            {
              text: `${index + 1}. ${option}`,
              callback_data: `answer-${card.id}-${index}`,
            },
          ]),
        };
      }
      const response = await fetch(`${base}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Telegram API ${response.status}`);
      await hub.delivered(card.id, card.version, `sent-${card.id}`);
    } catch (error) {
      log(`telegram: card ${card.id} not sent: ${error}`);
      await hub.failed(card.id, card.version, String(error)).catch(() => {});
    }
  }
}
