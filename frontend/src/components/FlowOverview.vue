<script setup lang="ts">
import { computed, watch, nextTick, useTemplateRef, shallowRef, onMounted, onBeforeUnmount } from "vue";
import { VueFlow, useVueFlow } from "@vue-flow/core";
import { Plus, Minus, Maximize, Workflow } from "@lucide/vue";
import FlowStage from "./FlowStage.vue";
import { buildWorkflow } from "../workflow";
import type { WorkflowProps, WorkflowEmits } from "../types/workflow";
const props = defineProps<WorkflowProps>();
const emit = defineEmits<WorkflowEmits>();
const canvasElement = useTemplateRef<HTMLDivElement>("canvasElement");
const canvasSize = shallowRef({ width: 0, height: 0 });
let observer: ResizeObserver | undefined;
onMounted(() => {
  observer = new ResizeObserver(([entry]) => {
    if (entry && entry.contentRect.width > 0 && entry.contentRect.height > 0)
      canvasSize.value = { width: entry.contentRect.width, height: entry.contentRect.height };
  });
  if (canvasElement.value) observer.observe(canvasElement.value);
});
onBeforeUnmount(() => observer?.disconnect());
const graph = computed(() => buildWorkflow(props.state, props.run, props.facts, props.live));
const { zoomIn, zoomOut, fitView, dimensions, onNodesInitialized } = useVueFlow("runtime-flow");
function fitCanvas() {
  void nextTick(() => fitView({ padding: 0.12 }));
}
onNodesInitialized(fitCanvas);
watch(
  () => [dimensions.value.width, dimensions.value.height],
  ([width, height]) => {
    if (width && height) fitCanvas();
  },
);
function choose(id: string) {
  if (id === "human") emit("inbox");
  else emit("filter", id === "agent" ? "claimed" : id === "queue" ? "queued" : "all");
}
</script>
<template>
  <section class="flow-panel" :class="{ 'flow-panel--paused': !live }" aria-label="实时运行画布">
    <div class="canvas-heading">
      <div>
        <Workflow :size="17" /><strong>{{ run ? "轮次 #" + run.id + " 的执行路径" : "中台运行全景" }}</strong
        ><span class="canvas-mode">只读流程</span>
      </div>
      <span class="canvas-hint">拖动画布 · 滚轮缩放 · 点击节点</span>
    </div>
    <div ref="canvasElement" class="flow-canvas">
      <VueFlow
        id="runtime-flow"
        v-if="canvasSize.width && canvasSize.height"
        :style="{ width: canvasSize.width + 'px', height: canvasSize.height + 'px' }"
        :nodes="graph.nodes"
        :edges="graph.edges"
        fit-view-on-init
        :min-zoom="0.25"
        :max-zoom="1.5"
        :nodes-draggable="false"
        :nodes-connectable="false"
        :edges-updatable="false"
        :zoom-on-double-click="false"
        :fit-view-params="{ padding: 0.15 }"
        @node-click="choose($event.node.id)"
      >
        <template #node-stage="nodeProps"><FlowStage v-bind="nodeProps" /></template>
      </VueFlow>
      <div class="canvas-controls" aria-label="画布控制">
        <button aria-label="放大画布" title="放大" @click="zoomIn()"><Plus :size="16" /></button
        ><button aria-label="缩小画布" title="缩小" @click="zoomOut()"><Minus :size="16" /></button
        ><button aria-label="适应全部节点" title="适应画布" @click="fitView({ padding: 0.15 })">
          <Maximize :size="16" />
        </button>
      </div>
      <div v-if="!state" class="canvas-empty"><span>连接中台后，流程将在这里实时展开</span></div>
    </div>
    <div class="canvas-legend">
      <span><i class="dot dot--green"></i>已记录</span><span><i class="dot dot--indigo"></i>执行中</span
      ><span><i class="dot dot--amber"></i>等待决定</span
      ><span class="legend-note">{{
        live ? "状态来自真实中台" : state ? "连接未就绪 · 动画已暂停" : "尚未连接 · 当前为流程结构"
      }}</span>
    </div>
    <div class="stage-shortcuts" aria-label="流程快捷筛选">
      <button @click="emit('filter', 'all')">全部轮次</button><button @click="emit('filter', 'queued')">事项队列</button
      ><button @click="emit('filter', 'claimed')">正在执行</button><button @click="emit('inbox')">待你决定</button>
    </div>
  </section>
</template>
