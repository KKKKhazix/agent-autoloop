import { shallowRef, getCurrentScope, onScopeDispose } from "vue";
import { watchFacts } from "../service/facts.ts";
import type { Fact } from "../types/console.ts";
import type { FactStreamOptions, StreamStatus } from "../types/realtime.ts";

/** Each connection owns one subscription, cursor and retry; an old owner cannot update the new one. */
export function useFactStream(options: FactStreamOptions) {
  const status = shallowRef<StreamStatus>("disconnected");
  const activity = shallowRef<Fact[]>([]);
  const error = shallowRef("");
  let generation = 0,
    cursor = 0;
  let controller = new AbortController();
  let retry: ReturnType<typeof setTimeout> | undefined;
  function disconnect() {
    generation++;
    controller.abort();
    clearTimeout(retry);
    cursor = 0;
    status.value = "disconnected";
    activity.value = [];
    error.value = "";
  }
  function connect(key: string) {
    disconnect();
    controller = new AbortController();
    const version = generation,
      signal = controller.signal;
    status.value = "connecting";
    async function listen() {
      try {
        await (options.subscribe ?? watchFacts)(
          key,
          cursor,
          signal,
          (fact) => {
            if (version !== generation || signal.aborted || fact.seq <= cursor) return;
            cursor = fact.seq;
            activity.value = [fact, ...activity.value].slice(0, 12);
            options.onChange();
          },
          () => {
            if (version !== generation || signal.aborted) return;
            status.value = "live";
            error.value = "";
            options.onOpen?.();
          },
          options.fetcher,
        );
        if (!signal.aborted) throw new Error("实时连接已断开。");
      } catch (cause) {
        if (version !== generation || signal.aborted) return;
        status.value = "reconnecting";
        error.value = cause instanceof Error ? cause.message : "实时连接已断开。";
        retry = setTimeout(() => void listen(), options.retryDelay ?? 2000);
      }
    }
    void listen();
  }
  if (getCurrentScope()) onScopeDispose(disconnect);
  return { status, activity, error, connect, disconnect };
}
