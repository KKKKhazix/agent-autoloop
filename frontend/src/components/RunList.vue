<script setup lang="ts">
import { computed, shallowRef } from "vue";
import { labels, time } from "../model";
import type { RunListProps, RunListEmits } from "../types/console";
const props = defineProps<RunListProps>();
const emit = defineEmits<RunListEmits>();
const query = shallowRef("");
const filters = [
  ["all", "全部"],
  ["claimed", "执行中"],
  ["queued", "排队"],
  ["done", "已完成"],
  ["unknown", "不确定"],
];
const visible = computed(() =>
  props.runs.filter(
    (r) =>
      (props.filter === "all" || r.state === props.filter) &&
      [r.id, r.rule, r.summary, ...r.events.map((e) => e.subject)]
        .join(" ")
        .toLowerCase()
        .includes(query.value.toLowerCase()),
  ),
);
</script>
<template>
  <section class="run-panel">
    <div class="section-heading">
      <div>
        <span class="eyebrow">执行记录</span>
        <h2>
          任务轮次 <span class="count">{{ runs.length }}</span>
        </h2>
      </div>
    </div>
    <label class="sr-only" for="run-search">搜索轮次</label
    ><input id="run-search" v-model="query" class="search" placeholder="搜索编号、规则或事项" />
    <div class="filters">
      <button
        v-for="item in filters"
        :key="item[0]"
        :aria-pressed="filter === item[0]"
        :class="{ selected: filter === item[0] }"
        @click="emit('filter', item[0]!)"
      >
        {{ item[1] }}
      </button>
    </div>
    <div class="run-list">
      <button
        v-for="item in visible"
        :key="item.id"
        class="run-row"
        :class="{ chosen: selected === item.id }"
        :aria-pressed="selected === item.id"
        @click="emit('select', item.id)"
      >
        <div class="row-top">
          <span class="badge" :class="item.state">{{
            item.stopping ? "正在停止" : (labels[item.state] ?? item.state)
          }}</span><span class="mono muted">#{{ item.id }}</span>
        </div>
        <strong>{{ item.rule }}</strong>
        <p>{{ item.summary || item.events[0]?.summary || "等待 Agent 交回执行结果" }}</p>
        <div class="row-bottom">
          <span>{{ item.events[0]?.subject || item.agent }}</span><time>{{ time(item.createdAt) }}</time>
        </div>
      </button>
      <div v-if="!visible.length" class="empty">
        <span class="empty-icon">⌕</span>
        <h3>还没有匹配的轮次</h3>
        <p>试试其他关键词，或等待新的事件进入中台。</p>
      </div>
    </div>
    <button v-if="hasMore" class="load-more" :disabled="busy" @click="emit('more')">
      {{ busy ? "加载中…" : "加载更早的轮次 ↓" }}
    </button>
  </section>
</template>
