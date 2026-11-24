import { useCallback, useEffect, useRef, useState } from "react";
import { api, msg, session } from "./common";
import type { State, Fact } from "./types";
export function useHub() {
  const [state, setState] = useState<State | null>(null),
    [error, setError] = useState(""),
    [facts, setFacts] = useState<Fact[]>([]),
    [stream, setStream] = useState("等待连接");
  const [start, setStart] = useState<number | null>(null);
  const pending = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    pending.current ??= api<State>("/state")
      .then((next) => {
        setState(next);
        setError("");
        setStart((prev) => prev ?? next.seq);
      })
      .catch((e) => setError(msg(e)))
      .finally(() => {
        pending.current = null;
      });
    return pending.current;
  }, []);
  useEffect(() => {
    void refresh();
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, [refresh]);
  useEffect(() => {
    if (start === null) return;
    const feed = new EventSource("/api/stream?after=" + start + "&session=" + session);
    let timer: ReturnType<typeof setTimeout> | undefined;
    feed.onopen = () => setStream("已连接");
    feed.onerror = () => setStream("重新连接中");
    feed.addEventListener("fact", (e: MessageEvent<string>) => {
      const fact: Fact = JSON.parse(e.data);
      setFacts((items) => (items[0]?.seq >= fact.seq ? items : [fact, ...items].slice(0, 160)));
      if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void refresh();
        }, 300);
    });
    return () => {
      feed.close();
      clearTimeout(timer);
    };
  }, [start, refresh]);
  return { state, error, refresh, facts, stream };
}
