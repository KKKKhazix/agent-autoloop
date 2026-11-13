import { createParser } from "eventsource-parser";
import type { Fact } from "../types/console.ts";
import type { FactSubscription } from "../types/realtime.ts";

/** Read authenticated SSE incrementally; credentials never enter the URL. */
export const watchFacts: FactSubscription = async (key, after, signal, onFact, onOpen, fetcher = fetch) => {
  const response = await fetcher(`/v1/stream?after=${after}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: "text/event-stream" },
    signal,
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream") || !response.body)
    throw new Error(response.status === 401 ? "实时连接的密钥无效或已撤销。" : "实时连接暂不可用。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createParser({
    onEvent(event) {
      if (event.event !== "fact") return;
      const fact = JSON.parse(event.data) as Fact;
      if (!Number.isSafeInteger(fact.seq) || !Array.isArray(fact.changes)) throw new Error("实时记录格式不正确。");
      onFact(fact);
    },
  });
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (typeof window !== "undefined") window.addEventListener("offline", cancel, { once: true });
  try {
    signal.throwIfAborted();
    onOpen();
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (typeof window !== "undefined") window.removeEventListener("offline", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};
