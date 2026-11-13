<script setup lang="ts">
import { reactive, shallowRef } from "vue";
import type { EventComposerProps, EventComposerEmits } from "../types/console";
defineProps<EventComposerProps>();
const emit = defineEmits<EventComposerEmits>();
const key = shallowRef("");
const event = reactive({ id: "", type: "", subject: "", summary: "", detail: "", link: "" });
</script>
<template>
  <section class="composer">
    <div class="section-heading">
      <div>
        <span class="eyebrow">新增事件</span>
        <h2>把一件新事交给中台</h2>
      </div>
      <button @click="emit('close')">关闭</button>
    </div>
    <p class="muted">发送需要单独的来源密钥，本人密钥不能发事件。来源身份由密钥决定；保留事件编号可安全重试。</p>
    <form class="composer-grid" @submit.prevent="emit('send', key, { ...event })">
      <label>来源密钥<input v-model="key" type="password" autocomplete="off" required /></label
      ><label>事件编号<input v-model="event.id" maxlength="200" placeholder="例如 alert-2026-001" required /></label
      ><label>事件类型<input v-model="event.type" maxlength="64" placeholder="例如 alert.new" required /></label
      ><label>事项对象<input v-model="event.subject" maxlength="100" placeholder="例如 #42" /></label
      ><label>一句话摘要<input v-model="event.summary" maxlength="200" /></label
      ><label>原始链接<input v-model="event.link" type="url" maxlength="500" placeholder="https://example.com" /></label
      ><label class="wide">详细资料<textarea v-model="event.detail" maxlength="4000"></textarea></label>
      <div class="wide">
        <button class="primary" :disabled="pending">{{ pending ? "正在提交…" : "发送事件" }}</button>
      </div>
    </form>
  </section>
</template>
