<script setup lang="ts">
import type { ConnectionProps, ConnectionEmits } from "../types/console";
defineProps<ConnectionProps>();
const emit = defineEmits<ConnectionEmits>();
// Autofill may update the DOM without emitting input; submit the visible value rather than a stale model.
function connect(event: SubmitEvent) {
  const form = event.currentTarget as HTMLFormElement;
  const key = String(new FormData(form).get("owner") ?? "").trim();
  if (!key) return;
  emit("connect", key);
  form.reset();
}
</script>
<template>
  <section class="connection">
    <div>
      <h2>连接你的中台</h2>
      <p>使用本人密钥查看状态并操作卡片、停止任务。密钥仅保存在本页内存中，刷新后清除。</p>
    </div>
    <form @submit.prevent="connect">
      <label for="owner-key">本人密钥</label>
      <div class="input-row">
        <input
          id="owner-key"
          name="owner"
          type="password"
          autocomplete="off"
          placeholder="输入本人密钥"
          required
          :disabled="busy"
        /><button class="primary" :disabled="busy">{{ busy ? "连接中…" : "连接中台" }}</button
        ><button v-if="connected" type="button" @click="emit('disconnect')">断开</button>
      </div>
    </form>
  </section>
</template>
