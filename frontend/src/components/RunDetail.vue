<script setup lang="ts">
import { computed, shallowRef, watch } from "vue";
import { labels, time, timeline, safeLink, factTitles } from "../model";
import type { DetailProps, DetailEmits } from "../types/console";
const props = defineProps<DetailProps>();
const emit = defineEmits<DetailEmits>();
const confirming = shallowRef(false);
watch(
  () => props.run?.id,
  () => (confirming.value = false),
);
const entries = computed(() =>
  props.run
    ? timeline(props.facts, props.run.id).map((fact) => ({
        ...fact,
        changes: [...new Map(fact.changes.map((change) => [change.table + ":" + change.key, change])).values()],
      }))
    : [],
);
</script>
<template>
  <aside class="detail-panel">
    <div v-if="!run" class="empty detail-empty">
      <span class="empty-icon">⌁</span>
      <h2>执行过程，一目了然</h2>
      <p>从左侧选择一轮，查看输入、执行、回执和回答。</p>
    </div>
    <template v-else
      ><div class="section-heading">
        <div>
          <span class="eyebrow">轮次 #{{ run.id }}</span>
          <h2>{{ run.rule }}</h2>
        </div>
        <span class="badge" :class="run.state">{{ run.stopping ? "正在停止" : (labels[run.state] ?? run.state) }}</span>
      </div>
      <p class="detail-summary">{{ run.summary || "这一轮还没有交回结果。" }}</p>
      <dl class="metadata">
        <div>
          <dt>执行 Agent</dt>
          <dd>{{ run.agent }}</dd>
        </div>
        <div>
          <dt>执行次数</dt>
          <dd>{{ run.attempts }}</dd>
        </div>
        <div>
          <dt>开始</dt>
          <dd>{{ time(run.claimedAt) }}</dd>
        </div>
        <div>
          <dt>结束</dt>
          <dd>{{ time(run.finishedAt) }}</dd>
        </div>
      </dl>
      <p v-if="run.error" class="error">{{ run.error }}</p>
      <a v-if="safeLink(run.link)" :href="safeLink(run.link)" target="_blank" rel="noopener noreferrer">打开原会话 ↗</a>
      <div v-if="['queued', 'claimed', 'unknown'].includes(run.state) && !run.stopping" class="stop-area">
        <button v-if="!confirming" class="danger" @click="confirming = true">停止这一轮</button>
        <div v-else class="confirmation">
          <p>确认停止第 {{ run.id }} 轮「{{ run.rule }}」？中台将请求执行程序停止，并等待确认。</p>
          <button
            class="danger"
            :disabled="pending"
            @click="
              emit('stop', run.id);
              confirming = false;
            "
          >
            确认停止</button
          ><button @click="confirming = false">继续执行</button>
        </div>
      </div>
      <h3 class="timeline-title">事件与执行时间线</h3>
      <p v-if="busy" role="status" class="muted">正在读取这一轮的记录…</p>
      <div v-if="error" class="error">{{ error }} <button @click="emit('retry')">重新读取</button></div>
      <ol class="timeline">
        <li v-for="fact in entries" :key="fact.seq">
          <div class="timeline-dot"></div>
          <time>{{ time(fact.at) }}</time><strong>{{ factTitles[fact.type] ?? "状态更新" }}</strong>
          <div v-for="(change, index) in fact.changes" :key="change.table + change.key + index">
            <p>
              {{
                change.row?.summary ||
                change.row?.title ||
                change.row?.answer ||
                change.row?.error ||
                (change.table === "runs" ? labels[String(change.row?.state)] : "资料已记录")
              }}
            </p>
          </div>
          <details>
            <summary>查看原始记录 · #{{ fact.seq }}</summary>
            <pre>{{ JSON.stringify(fact, null, 2) }}</pre>
          </details>
        </li>
      </ol>
      <p v-if="!busy && !entries.length && !error" class="muted">暂时没有关联记录。</p></template
    >
  </aside>
</template>
