<script setup lang="ts">
import { reactive } from "vue";
import type { InboxProps, InboxEmits, CardDraft } from "../types/console";
defineProps<InboxProps>();
const emit = defineEmits<InboxEmits>();
const drafts = reactive<Record<number, CardDraft>>({});
function draft(id: number) {
  return drafts[id] ?? (drafts[id] = { choice: "", text: "", reason: "", resolve: false });
}
</script>
<template>
  <section id="inbox" class="inbox">
    <div class="section-heading">
      <div>
        <span class="eyebrow">等待本人处理</span>
        <h2>
          需要你的决定 <span class="count">{{ cards.length }}</span>
        </h2>
      </div>
      <span class="muted">卡片内容来自执行回执</span>
    </div>
    <div v-if="!cards.length" class="quiet">
      <span>✓</span>
      <div>
        <strong>暂时没有需要你处理的事</strong>
        <p>Agent 会按规则继续工作，需要你的决定时会出现在这里。</p>
      </div>
    </div>
    <div class="inbox-grid">
      <article v-for="card in cards" :key="card.id" class="inbox-card">
        <div class="row-top">
          <span class="badge" :class="card.kind === 'ask' ? 'queued' : 'done'">{{
            card.kind === "ask" ? "等待回答" : "通知"
          }}</span><span class="mono muted">#{{ card.id }}</span>
        </div>
        <h3>{{ card.title }}</h3>
        <p class="card-text">{{ card.text }}</p>
        <span class="muted">{{ card.rule }}</span>
        <form
          v-if="card.kind === 'ask'"
          @submit.prevent="
            emit('answer', card.id, {
              ...(draft(card.id).choice !== '' ? { choice: Number(draft(card.id).choice) } : {}),
              ...(draft(card.id).text ? { text: draft(card.id).text } : {}),
            })
          "
        >
          <fieldset :disabled="pending">
            <legend>选择你的回答</legend>
            <label v-for="(option, index) in card.options" :key="index" class="option"
              ><input
                v-model="draft(card.id).choice"
                type="radio"
                :name="'choice-' + card.id"
                :value="String(index)"
              />{{ option }}<small v-if="card.recommend === index">推荐</small></label
            ><label :for="'answer-' + card.id">补充说明</label
            ><textarea
              :id="'answer-' + card.id"
              v-model="draft(card.id).text"
              maxlength="4000"
              placeholder="可以补充具体情况或下一步要求"
            ></textarea
            ><button
              class="primary"
              :disabled="pending || (!draft(card.id).text.trim() && draft(card.id).choice === '')"
            >
              提交回答
            </button>
          </fieldset>
        </form>
        <button v-else :disabled="pending" @click="emit('answer', card.id, { choice: 0 })">已处理</button
        ><button class="text-button" @click="draft(card.id).resolve = !draft(card.id).resolve">
          问题已解决，直接结案
        </button>
        <form
          v-if="draft(card.id).resolve"
          class="confirmation"
          @submit.prevent="emit('resolve', card.id, draft(card.id).reason)"
        >
          <label :for="'reason-' + card.id">确认结案卡片 #{{ card.id }}？</label
          ><input
            :id="'reason-' + card.id"
            v-model="draft(card.id).reason"
            required
            maxlength="1000"
            placeholder="请说明在哪里核实了问题已解决"
          /><button class="danger" :disabled="pending || !draft(card.id).reason.trim()">确认结案</button
          ><button type="button" @click="draft(card.id).resolve = false">取消</button>
        </form>
      </article>
    </div>
  </section>
</template>
