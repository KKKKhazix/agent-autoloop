<script setup lang="ts">
import { computed } from "vue";
import { Radio } from "@lucide/vue";
import { time, factTitles } from "../model";
import type { ActivityProps } from "../types/workflow";
const props = defineProps<ActivityProps>();
const visible = computed(() => props.facts.slice(0, 6));
</script>
<template>
  <section class="activity-feed">
    <div class="section-heading">
      <h2><Radio :size="15" /> 事实动态</h2>
      <span class="muted">最近记录 · 非 Agent 内部思考</span>
    </div>
    <div v-if="!visible.length" class="activity-empty">
      {{ connected ? "订阅已建立，等待事实记录" : "连接后显示事件、执行与回答记录" }}
    </div>
    <ol v-else class="activity-list">
      <li v-for="fact in visible" :key="fact.seq">
        <span class="activity-mark"></span><strong>{{ factTitles[fact.type] ?? "状态更新" }}</strong
        ><span class="mono">#{{ fact.seq }}</span
        ><time>{{ time(fact.at) }}</time>
      </li>
    </ol>
  </section>
</template>
