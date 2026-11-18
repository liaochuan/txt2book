<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { BookMeta, Language } from "../types/book";

const props = defineProps<{ meta: BookMeta }>();

const emit = defineEmits<{
  "update:meta": [meta: BookMeta];
}>();

/** 输入停顿多久后提交一次，避免每个按键都写进撤销历史。 */
const DEBOUNCE_MS = 300;

const title = ref(props.meta.title);
const author = ref(props.meta.author);
const language = ref<Language>(props.meta.language);
const description = ref(props.meta.description ?? "");

let timer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

/** 始终带上 description 键，清空时传 undefined，确保父级合并时能真正删除旧简介。 */
function snapshot(): BookMeta {
  const text = description.value;
  return {
    title: title.value,
    author: author.value,
    language: language.value,
    description: text === "" ? undefined : text,
  };
}

function cancelTimer(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
}

function isSameMeta(a: BookMeta, b: BookMeta): boolean {
  return (
    a.title === b.title &&
    a.author === b.author &&
    a.language === b.language &&
    (a.description ?? "") === (b.description ?? "")
  );
}

/** 立即提交尚未发出的本地编辑；重复调用是安全的。 */
function flush(): void {
  cancelTimer();
  if (!dirty) return;
  dirty = false;
  const next = snapshot();
  if (isSameMeta(next, props.meta)) return;
  emit("update:meta", next);
}

function schedule(): void {
  dirty = true;
  cancelTimer();
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, DEBOUNCE_MS);
}

/** 下拉选择不需要防抖，立即提交并顺带清掉待提交的文本编辑。 */
function onLanguageChange(): void {
  dirty = true;
  flush();
}

/** 输入法组合期间的回车只用于上屏，不触发提交。 */
function onEnter(event: KeyboardEvent): void {
  if (event.isComposing) return;
  event.preventDefault();
  flush();
}

// 外部换书、导入或撤销时，旧草稿绝不能写到新目标上：
// 取消定时器、丢弃 dirty 状态并无条件同步字段。
watch(
  () => props.meta,
  (next) => {
    cancelTimer();
    dirty = false;
    title.value = next.title;
    author.value = next.author;
    language.value = next.language;
    description.value = next.description ?? "";
  },
  { deep: true },
);

onBeforeUnmount(flush);
</script>

<template>
  <section class="card book-meta">
    <header class="book-meta-header">
      <h2 class="book-meta-title">书籍信息</h2>
      <p class="book-meta-hint">书名、作者与简介会写入电子书的元数据。</p>
    </header>

    <div class="book-meta-grid">
      <div class="field">
        <label for="book-meta-title">书名</label>
        <input
          id="book-meta-title"
          v-model="title"
          data-test="meta-title"
          type="text"
          placeholder="书名"
          autocomplete="off"
          @input="schedule"
          @blur="flush"
          @keydown.enter="onEnter"
        />
      </div>

      <div class="field">
        <label for="book-meta-author">作者</label>
        <input
          id="book-meta-author"
          v-model="author"
          data-test="meta-author"
          type="text"
          placeholder="可选"
          autocomplete="off"
          @input="schedule"
          @blur="flush"
          @keydown.enter="onEnter"
        />
      </div>

      <div class="field">
        <label for="book-meta-language">语言</label>
        <select
          id="book-meta-language"
          v-model="language"
          data-test="meta-language"
          @change="onLanguageChange"
        >
          <option value="zh-CN">简体中文</option>
          <option value="en">English</option>
        </select>
      </div>

      <div class="field book-meta-wide">
        <label for="book-meta-description">简介</label>
        <textarea
          id="book-meta-description"
          v-model="description"
          data-test="meta-description"
          rows="3"
          placeholder="可选，会写入电子书简介"
          @input="schedule"
          @blur="flush"
        />
      </div>
    </div>
  </section>
</template>
