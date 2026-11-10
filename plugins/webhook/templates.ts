// Vendor message formats: links are listed in protocol.md so the fields can be checked against their owning APIs.
import { t } from "../../host/i18n.ts";
function wecomMarkdown(text: string) {
  return text.replace(/https?:\/\/[^\s；，。]+/g, (url, offset, source) =>
    source.slice(Math.max(0, offset - 2), offset) === "](" ? url : t('[打开链接]({"url"})', { url }),
  );
}

export function payload(platform: string, text: string): object {
  if (platform === "discord" && [...text].length > 2000) throw new Error(t("Discord 消息超过 2000 个字，请缩短卡片"));
  const markdown = platform === "wecom" ? wecomMarkdown(text) : "";
  if (platform === "wecom" && Buffer.byteLength(markdown) > 2048)
    throw new Error(t("企微消息超过 2048 字节，请缩短卡片"));
  switch (platform) {
    case "dingtalk":
      return { msgtype: "text", text: { content: text }, at: { isAtAll: false } };
    case "wecom":
      return { msgtype: "markdown", markdown: { content: markdown } };
    case "slack":
      return { text, mrkdwn: false, unfurl_links: false, unfurl_media: false };
    case "discord":
      return { content: text, allowed_mentions: { parse: [] } };
    default:
      throw new Error(t('没有这个 Webhook 模板：{"platform"}', { platform }));
  }
}

export async function accepted(platform: string, response: Response) {
  if (!response.ok) throw new Error(t('返回 {"status"}', { status: response.status }));
  if (platform === "dingtalk" || platform === "wecom") {
    const result = await response.json();
    if (result.errcode !== 0) throw new Error(t('发送失败：{"why"}', { why: result.errmsg ?? result.errcode }));
  } else if (platform === "slack" && (await response.text()).trim() !== "ok")
    throw new Error(t("Slack 没有确认收到消息"));
}
