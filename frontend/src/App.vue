<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { useConsole } from "./hooks/useConsole";
import { Workflow, Radio, RefreshCw, Settings2, Plus, PanelRight, ListFilter, ChevronRight } from "@lucide/vue";
import ActivityFeed from "./components/ActivityFeed.vue";
import { time } from "./model";
import ConnectionPanel from "./components/ConnectionPanel.vue";
import FlowOverview from "./components/FlowOverview.vue";
import RunList from "./components/RunList.vue";
import RunDetail from "./components/RunDetail.vue";
import CardInbox from "./components/CardInbox.vue";
import EventComposer from "./components/EventComposer.vue";
import type { Answer, EventInput } from "./types/console";
const {
  streamStatus,
  streamError,
  activity,
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
  disconnect: disconnectHub,
  refresh,
  select,
  more,
  loadDetail,
  action,
} = useConsole();
const sessionKey = shallowRef(0);
function disconnect() {
  sessionKey.value++;
  composer.value = false;
  disconnectHub();
}
const settings = shallowRef(true),
  composer = shallowRef(false),
  filter = shallowRef("all"),
  inspector = shallowRef("trace");
const live = computed(() => streamStatus.value === "live" && !error.value);
const connectionLabel = computed(() =>
  !connected.value
    ? "未连接"
    : error.value || streamStatus.value === "reconnecting"
      ? "连接中断"
      : live.value
        ? "实时同步中"
        : "正在连接",
);
async function chooseRun(id: number) {
  inspector.value = "trace";
  await select(id);
}
function showInbox() {
  inspector.value = "inbox";
  document.getElementById("inspector")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
const metrics = computed(() => [
  { label: "正在执行", value: state.value?.totals.running, unit: "轮", tone: "indigo" },
  { label: "等待执行", value: state.value?.totals.queued, unit: "轮", tone: "orange" },
  { label: "需要你处理", value: state.value?.totals.attention, unit: "张卡片", tone: "orange" },
  { label: "今天已完成", value: state.value?.totals.doneToday, unit: "轮", tone: "" },
]);
async function open(key: string) {
  sessionKey.value++;
  composer.value = false;
  await connect(key);
  if (!error.value) settings.value = false;
}
function answer(id: number, body: Answer) {
  void action((client) => client.answer(id, body), "回答已提交，事项将继续处理。");
}
function resolve(id: number, reason: string) {
  void action((client) => client.resolve(id, reason), "卡片已结案。");
}
function stop(id: number) {
  void action((client) => client.stop(id), "停止请求已提交，请等待执行程序确认。");
}
function send(key: string, event: EventInput) {
  void action(async (client) => {
    const result = await client.emit(key, event);
    return result;
  }, "事件已提交；相同来源与编号会由中台去重，请查看对应轮次。");
}
</script>
<template>
  <div class="app-shell">
    <header class="app-header">
      <a href="#" class="brand"
        ><span class="brand-mark"><Workflow :size="22" /></span
        ><span>Autoloop<span class="brand-divider">/</span><small>运行工作台</small></span></a
      >
      <div class="header-actions">
        <span class="connection-status" :class="{ live }"><i></i>{{ connectionLabel }}</span>
        <button class="icon-button" title="连接设置" aria-label="连接设置" @click="settings = !settings">
          <Settings2 :size="17" />
        </button>
        <button :disabled="!connected || busy" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: busy }" /><span>刷新</span>
        </button>
        <button class="primary" :disabled="!state" @click="composer = !composer"><Plus :size="16" />发送事件</button>
      </div>
    </header>
    <main>
      <div class="page-intro">
        <div>
          <div class="breadcrumb">工作空间 <ChevronRight :size="13" /> 运行监控</div>
          <h1>流程运行台 <span class="version-chip">LIVE</span></h1>
          <p>让事件、执行和每一次决定，都在同一张图上连接起来。</p>
        </div>
        <div class="refresh-caption">
          <span><Radio :size="14" /> 实时事实订阅</span><span>上次更新 {{ time(updated) }}</span>
        </div>
      </div>
      <ConnectionPanel v-if="settings" :connected="connected" :busy="busy" @connect="open" @disconnect="disconnect" />
      <div v-if="error || streamError" role="alert" class="error-banner">
        <strong>{{ error || streamError }}</strong><span>{{
          state ? "当前显示上次读取的数据，可能已经过期。流程动画已暂停。" : "请检查中台地址、代理设置和本人密钥。"
        }}</span
        ><button :disabled="busy || !connected" @click="refresh">重新读取</button>
      </div>
      <div v-if="message" role="status" class="message-banner">{{ message }}</div>
      <EventComposer
        :key="'event-' + sessionKey"
        v-if="composer && connected"
        :pending="pending"
        @send="send"
        @close="composer = false"
      />
      <section class="metrics" aria-label="运行概况">
        <div v-for="metric in metrics" :key="metric.label" class="metric">
          <span><i :class="metric.tone"></i>{{ metric.label }}</span
          ><strong
            >{{ metric.value ?? "—" }}<small>{{ metric.unit }}</small></strong
          ><span class="metric-caption">{{
            metric.label === "需要你处理"
              ? "回答或结案后继续"
              : metric.label === "正在执行"
                ? "接单端正在处理"
                : metric.label === "等待执行"
                  ? "等待可用执行容量"
                  : "以中台记录为准"
          }}</span>
        </div>
      </section>
      <div class="workspace">
        <RunList
          :runs="runs"
          :selected="selected"
          :has-more="hasMore"
          :busy="busy"
          :filter="filter"
          @select="chooseRun"
          @more="more"
          @filter="filter = $event"
        />
        <div class="canvas-column">
          <FlowOverview
            :state="state"
            :run="run"
            :facts="facts"
            :live="live"
            @filter="filter = $event"
            @inbox="showInbox"
          /><ActivityFeed :facts="activity" :connected="live" />
          <div class="canvas-footnote">
            <span class="mono">HTTP + JSON / SSE</span><span>只展示已上报的事实，不推测 Agent 内部步骤</span
            ><button
              v-if="run"
              class="text-button"
              @click="
                selected = null;
                facts = [];
              "
            >
              返回全局视图
            </button>
          </div>
        </div>
        <section id="inspector" class="inspector">
          <div class="inspector-tabs">
            <button :aria-pressed="inspector === 'trace'" @click="inspector = 'trace'">
              <PanelRight :size="15" />执行详情</button
            ><button :aria-pressed="inspector === 'inbox'" @click="inspector = 'inbox'">
              <ListFilter :size="15" />待你处理 <span class="count">{{ state?.cards.length ?? 0 }}</span>
            </button>
          </div>
          <RunDetail
            v-show="inspector === 'trace'"
            :run="run"
            :facts="facts"
            :busy="detailBusy"
            :error="detailError"
            :pending="pending"
            @stop="stop"
            @retry="loadDetail"
          /><CardInbox
            :key="'inbox-' + sessionKey"
            v-show="inspector === 'inbox'"
            :cards="state?.cards ?? []"
            :pending="pending"
            @answer="answer"
            @resolve="resolve"
          />
        </section>
      </div>
      <footer>
        <span
          ><i class="dot" :class="{ 'dot--green': live }"></i>{{ live ? "事实流已连接" : "等待实时连接" }} ·
          凭据仅保存在内存</span
        ><span v-if="state"
          >今日已上报 {{ state.spending.today.tokens.toLocaleString() }} tokens · ${{
            state.spending.today.cost.toFixed(4)
          }}<span class="usage-note"
            >{{ state.spending.today.missingTokens }} 轮未上报 Token /
            {{ state.spending.today.missingCost }} 轮未上报费用</span
          ></span
        >
      </footer>
    </main>
  </div>
</template>
