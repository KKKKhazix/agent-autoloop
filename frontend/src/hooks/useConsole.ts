import { shallowRef, computed, getCurrentScope, onScopeDispose } from "vue";
import { useFactStream } from "./useFactStream.ts";
import { createHub } from "../service/hub.ts";
import { mergeRuns, runFromFacts } from "../model.ts";
import type { ConsoleOptions, HubState, Run, Fact } from "../types/console.ts";
/** Own one connection generation and cancel obsolete reads without replaying writes. */
export function useConsole(options: ConsoleOptions = {}) {
  const state = shallowRef<HubState | null>(null),
    runs = shallowRef<Run[]>([]),
    selected = shallowRef<number | null>(null),
    facts = shallowRef<Fact[]>([]),
    error = shallowRef(""),
    detailError = shallowRef(""),
    message = shallowRef(""),
    busy = shallowRef(false),
    detailBusy = shallowRef(false),
    pending = shallowRef(false),
    connected = shallowRef(false),
    updated = shallowRef(""),
    hasMore = shallowRef(false);
  let generation = 0,
    detailGeneration = 0,
    hub: ReturnType<typeof createHub> | null = null,
    controller = new AbortController(),
    detailController = new AbortController(),
    timer: ReturnType<typeof setTimeout> | undefined,
    cursor: number | null = null,
    loading = false;
  let changeTimer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  const realtime = options.realtime !== false;
  function scheduleRefresh() {
    dirty = true;
    if (changeTimer) return;
    const version = generation;
    changeTimer = setTimeout(() => {
      changeTimer = undefined;
      if (version === generation) void refresh();
    }, 100);
  }
  const stream = useFactStream({ onChange: scheduleRefresh, onOpen: scheduleRefresh, fetcher: options.fetcher });
  const run = computed(() => runs.value.find((r) => r.id === selected.value) ?? null);
  function disconnect() {
    generation++;
    detailGeneration++;
    stream.disconnect();
    clearTimeout(changeTimer);
    changeTimer = undefined;
    dirty = false;
    clearTimeout(timer);
    controller.abort();
    detailController.abort();
    hub = null;
    connected.value = false;
    state.value = null;
    runs.value = [];
    facts.value = [];
    selected.value = null;
    error.value = "";
    detailError.value = "";
    message.value = "";
    updated.value = "";
    busy.value = false;
    detailBusy.value = false;
    loading = false;
    pending.value = false;
    hasMore.value = false;
    cursor = null;
  }
  async function loadDetail() {
    if (!hub || selected.value === null) return;
    const id = selected.value,
      version = ++detailGeneration,
      connection = generation;
    detailController.abort();
    detailController = new AbortController();
    detailBusy.value = true;
    detailError.value = "";
    try {
      const result = await hub.why(id, detailController.signal);
      if (connection === generation && version === detailGeneration) facts.value = result;
    } catch (e) {
      if (connection === generation && version === detailGeneration && !detailController.signal.aborted)
        detailError.value = e instanceof Error ? e.message : "读取记录失败，请重试。";
    } finally {
      if (connection === generation && version === detailGeneration) detailBusy.value = false;
    }
  }
  async function select(id: number) {
    selected.value = id;
    facts.value = [];
    await loadDetail();
  }
  async function refresh() {
    if (!hub || loading) return;
    loading = true;
    dirty = false;
    busy.value = true;
    const version = generation;
    const oldRun = JSON.stringify(run.value);
    const oldCards = JSON.stringify([state.value?.cards, state.value?.recentCards]);
    clearTimeout(timer);
    try {
      const client = hub,
        signal = controller.signal;
      const result = await client.state(signal);
      if (version !== generation) return;
      const returned = new Set(result.runs.map((r) => r.id));
      const missing = runs.value.filter(
        (r) => ["queued", "claimed", "unknown"].includes(r.state) && !returned.has(r.id),
      );
      const completed: Run[] = [];
      let staleError = "";
      for (const previous of missing) {
        try {
          const history = await client.why(previous.id, signal);
          if (version !== generation) return;
          completed.push(runFromFacts(previous, history));
        } catch (e) {
          if (version !== generation) return;
          staleError = e instanceof Error ? e.message : "读取旧轮次状态失败。";
        }
      }
      if (version !== generation) return;
      const firstRead = state.value === null;
      state.value = result;
      runs.value = mergeRuns(runs.value, [...completed, ...result.runs]);
      if (firstRead) {
        cursor = result.nextBefore;
        hasMore.value = result.hasMore;
      }
      updated.value = new Date().toISOString();
      error.value = staleError;
      if (
        selected.value !== null &&
        (oldRun !== JSON.stringify(run.value) || oldCards !== JSON.stringify([result.cards, result.recentCards]))
      )
        void loadDetail();
    } catch (e) {
      if (version === generation && !controller.signal.aborted)
        error.value = e instanceof Error ? e.message : "读取记录失败，请重试。";
    } finally {
      if (version === generation) {
        loading = false;
        busy.value = false;
        if (!realtime) timer = setTimeout(() => void refresh(), options.interval ?? 3000);
        else if (dirty) scheduleRefresh();
      }
    }
  }
  async function connect(key: string) {
    disconnect();
    controller = new AbortController();
    hub = createHub(key, options.fetcher);
    connected.value = true;
    const version = generation;
    await refresh();
    if (version === generation && realtime) stream.connect(key);
  }
  async function more() {
    if (!hub || !cursor || loading) return;
    loading = true;
    busy.value = true;
    clearTimeout(timer);
    const version = generation;
    try {
      const result = await hub.state(controller.signal, cursor);
      if (version === generation) {
        runs.value = mergeRuns(result.runs, runs.value);
        cursor = result.nextBefore;
        hasMore.value = result.hasMore;
        error.value = "";
      }
    } catch (e) {
      if (version === generation) error.value = e instanceof Error ? e.message : "读取记录失败，请重试。";
    } finally {
      if (version === generation) {
        loading = false;
        busy.value = false;
        if (!realtime) timer = setTimeout(() => void refresh(), options.interval ?? 3000);
        else if (dirty) scheduleRefresh();
      }
    }
  }
  async function action(work: (client: ReturnType<typeof createHub>) => Promise<unknown>, success: string) {
    if (!hub || pending.value) return;
    const version = generation,
      client = hub;
    pending.value = true;
    message.value = "";
    try {
      await work(client);
      if (version !== generation) return;
      message.value = success;
      await refresh();
      await loadDetail();
    } catch (e) {
      if (version === generation)
        message.value =
          (e instanceof Error ? e.message : "操作结果未确认，请先刷新核对。") + " 请先刷新核对，写请求不会自动重发。";
    } finally {
      if (version === generation) pending.value = false;
    }
  }
  if (getCurrentScope()) onScopeDispose(disconnect);
  return {
    streamStatus: stream.status,
    streamError: stream.error,
    activity: stream.activity,
    state,
    runs,
    selected,
    facts,
    error,
    detailError,
    message,
    busy,
    detailBusy,
    pending,
    connected,
    updated,
    hasMore,
    run,
    connect,
    disconnect,
    refresh,
    select,
    more,
    loadDetail,
    action,
  };
}
