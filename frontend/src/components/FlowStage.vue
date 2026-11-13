<script setup lang="ts">
import { Handle, Position } from "@vue-flow/core";
import type { NodeProps } from "@vue-flow/core";
import {
  Radio,
  GitBranch,
  Layers,
  Bot,
  FileCheck2,
  UserRound,
  CircleCheck,
  Circle,
  LoaderCircle,
  Clock3,
  TriangleAlert,
} from "@lucide/vue";
import type { StageData } from "../types/workflow";
defineProps<NodeProps<StageData>>();
const icons = {
  events: Radio,
  rules: GitBranch,
  queue: Layers,
  agent: Bot,
  receipt: FileCheck2,
  human: UserRound,
  done: CircleCheck,
};
const statuses = { idle: "待命", done: "已记录", running: "执行中", waiting: "等待中", warning: "待确认" };
</script>
<template>
  <div
    class="stage"
    :class="['stage--' + data.status, { 'stage--selected': selected }]"
    :data-stage="id"
    :data-status="data.status"
  >
    <Handle type="target" id="left" :position="Position.Left" /><Handle
      type="target"
      id="top"
      :position="Position.Top"
    /><Handle type="target" id="bottom" :position="Position.Bottom" />
    <div class="stage__top">
      <span class="stage__icon"><component :is="icons[data.icon as keyof typeof icons]" :size="19" /></span
      ><span class="stage__step">{{ data.step }}</span>
    </div>
    <strong class="stage__title">{{ data.title }}</strong>
    <p class="stage__caption">{{ data.caption }}</p>
    <div class="stage__bottom">
      <span>{{ data.value }}</span><span class="stage__status"
        ><LoaderCircle v-if="data.status === 'running'" class="spin" :size="12" /><Clock3
          v-else-if="data.status === 'waiting'"
          :size="12"
        /><TriangleAlert v-else-if="data.status === 'warning'" :size="12" /><CircleCheck
          v-else-if="data.status === 'done'"
          :size="12"
        /><Circle v-else :size="10" />{{ statuses[data.status] }}</span
      >
    </div>
    <Handle type="source" id="right" :position="Position.Right" /><Handle
      type="source"
      id="bottom"
      :position="Position.Bottom"
    /><Handle type="source" id="left" :position="Position.Left" /><Handle
      type="source"
      id="top"
      :position="Position.Top"
    />
  </div>
</template>
