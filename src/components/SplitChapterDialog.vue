<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { isSuspectedHeadingLine } from "../core/chapterAnalysis";
import type { Chapter } from "../types/book";
import AppDialog from "./AppDialog.vue";

const props = defineProps<{
  open: boolean;
  chapter: Chapter | null;
  /** 预设切分点；由提醒卡片传入。 */
  initialLineIndex?: number;
}>();

const emit = defineEmits<{
  close: [];
  split: [{ chapterId: string; lineIndex: number; title: string; dropLine: boolean }];
}>();

const selected = ref<number | null>(null);
const title = ref("");
const dropLine = ref(false);
/** 单次渲染的最大行数；超长章节（如全书回退为一个正文章）分页展开。 */
const PAGE_SIZE = 200;
const visibleCount = ref(PAGE_SIZE);

const lines = computed<string[]>(() => props.chapter?.lines ?? []);

/** 只能从第 2 行开始切分，避免产生空的原章节。 */
const splitPoints = computed<number[]>(() =>
  lines.value.map((_line, index) => index).filter((index) => index > 0),
);

const visiblePoints = computed<number[]>(() =>
  splitPoints.value.slice(0, visibleCount.value),
);

const remaining = computed<number>(() =>
  Math.max(0, splitPoints.value.length - visibleCount.value),
);

/** 选中的行之后是否没有任何非空白正文。 */
const bodylessSplit = computed<boolean>(() => {
  if (selected.value === null) return false;
  const start = dropLine.value ? selected.value + 1 : selected.value;
  return !lines.value.slice(start).some((line) => line.trim() !== "");
});

/** 选中行本身是空白时不允许把它当标题移除。 */
const selectedBlank = computed<boolean>(
  () => selected.value !== null && (lines.value[selected.value] ?? "").trim() === "",
);

const canConfirm = computed<boolean>(() => selected.value !== null && !bodylessSplit.value);

/** 默认标题取行首 40 字，避免把整段正文塞进目录。 */
function defaultTitle(line: string): string {
  return line.trim().slice(0, 40) || "新章节";
}

function selectLine(index: number): void {
  // 重复点击同一行不覆盖用户改过的标题与勾选状态。
  if (selected.value === index) return;

  const line = lines.value[index] ?? "";
  selected.value = index;
  title.value = defaultTitle(line);
  // 与提醒卡片的疑似标题判定共用同一套规则。
  dropLine.value = isSuspectedHeadingLine(lines.value, index, props.chapter?.title);
}

function reset(): void {
  const chapter = props.chapter;
  const initial = props.initialLineIndex;
  visibleCount.value = Math.max(PAGE_SIZE, (initial ?? 0) + 1);
  // 重新打开或切换章节时清空，避免 selectLine 的“重复点击”保护吞掉重置。
  selected.value = null;
  if (chapter && initial !== undefined && initial > 0 && initial < chapter.lines.length) {
    selectLine(initial);
    return;
  }
  title.value = "";
  dropLine.value = false;
}

watch(
  () => [props.open, props.chapter?.id, props.initialLineIndex] as const,
  () => {
    if (props.open) reset();
  },
  { immediate: true },
);

function confirm(): void {
  const chapter = props.chapter;
  const lineIndex = selected.value;
  if (!chapter || lineIndex === null || !canConfirm.value) return;
  emit("split", {
    chapterId: chapter.id,
    lineIndex,
    title: title.value.trim() || defaultTitle(chapter.lines[lineIndex] ?? ""),
    dropLine: dropLine.value,
  });
}

function lineLabel(line: string): string {
  const text = line.trim();
  return text === "" ? "（空行）" : text;
}
</script>

<template>
  <AppDialog :open="open" title="手动分章" wide @close="emit('close')">
    <div v-if="chapter" class="split-dialog" data-test="split-dialog">
      <p class="split-hint">
        《{{ chapter.title }}》共 {{ chapter.lines.length }} 行。选择新章节的起始行，
        该行之前的正文留在原章节。
      </p>

      <ul class="split-lines">
        <li v-for="index in visiblePoints" :key="index">
          <button
            type="button"
            class="split-line"
            :class="{ 'split-line-selected': selected === index }"
            :data-test="`split-line-${index}`"
            :aria-pressed="selected === index ? 'true' : 'false'"
            @click="selectLine(index)"
          >
            <span class="split-line-no">{{ index + 1 }}</span>
            <span class="split-line-text">{{ lineLabel(chapter.lines[index] ?? "") }}</span>
          </button>
        </li>
      </ul>

      <button
        v-if="remaining > 0"
        type="button"
        class="btn btn-ghost split-more"
        data-test="split-more"
        @click="visibleCount += PAGE_SIZE"
      >
        显示更多（还有 {{ remaining }} 行）
      </button>

      <div class="field">
        <label class="field-label" for="split-title">新章节标题</label>
        <input
          id="split-title"
          v-model="title"
          data-test="split-title"
          type="text"
          :disabled="selected === null"
          placeholder="选择起始行后自动填入"
        />
      </div>

      <label class="split-check">
        <input
          v-model="dropLine"
          data-test="split-drop-line"
          type="checkbox"
          :disabled="selectedBlank"
        />
        选中的行作为标题，从正文中移除
      </label>

      <p v-if="bodylessSplit" class="split-hint split-warning" data-test="split-body-hint">
        最后一行不能作为标题移除，请取消勾选，让它留在正文中。
      </p>

      <div class="split-actions">
        <button type="button" class="btn btn-ghost" data-test="split-cancel" @click="emit('close')">
          取消
        </button>
        <button
          type="button"
          class="btn btn-primary"
          data-test="split-confirm"
          :disabled="!canConfirm"
          @click="confirm"
        >
          分章
        </button>
      </div>
    </div>
  </AppDialog>
</template>
