import type { Answer, EventInput, Fact, Fetcher, HubState, EmittedEvent } from "../types/console.ts";
/** Build a same-origin client; credentials only travel in headers. */
export function createHub(owner: string, fetcher: Fetcher = fetch) {
  async function request<T>(path: string, key: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const deadline = AbortSignal.timeout(15000);
    const response = await fetcher("/v1" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: "Bearer " + key,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      credentials: "omit",
      redirect: "error",
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(
        data.error || (response.status === 401 ? "密钥无效或权限不符。" : `中台返回错误（${response.status}）`),
      );
    }
    return response.json();
  }
  return {
    state: (signal?: AbortSignal, before?: number) =>
      request<HubState>("/state" + (before ? "?before=" + before : ""), owner, undefined, signal),
    why: (id: number, signal?: AbortSignal) => request<Fact[]>("/runs/" + id + "/why", owner, undefined, signal),
    answer: (id: number, body: Answer) => request("/cards/" + id + "/answer", owner, body),
    resolve: (id: number, reason: string) => request("/cards/" + id + "/resolve", owner, { reason }),
    stop: (id: number) => request("/runs/" + id + "/cancel", owner, {}),
    emit: (key: string, body: EventInput) => request<EmittedEvent>("/events", key, body),
  };
}
