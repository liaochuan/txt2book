<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { analyzeChapters, type ContinuityIssueKind } from "../core/chapterAnalysis";
import type { Chapter } from "../types/book";

const props = defineProps<{
  chapters: Chapter[];
}>();

const emit = defineEmits<{
  "select-chapter": [id: string];
  "split-chapter": [{ chapterId: string; lineIndex: number }];
}>();

const EXPAND_LIMIT = 20;

const expanded = ref(false);
const report = computed(() => analyzeChapters(props.chapters));
const visibleContinuity = computed(() =>
  expanded.value ? report.value.continuity : report.value.continuity.slice(0, EXPAND_LIMIT),
);
const visibleSuspected = computed(() =>
  expanded.value ? report.value.suspected : report.value.suspected.slice(0, EXPAND_LIMIT),
);
const hiddenCount = computed<number>(
  () =>
    report.value.continuity.length +
    report.value.suspected.length -
    visibleContinuity.value.length -
    visibleSuspected.value.length,
);

const KIND_LABEL: Record<ContinuityIssueKind, string> = {
  gap: "缺号",
  duplicate: "重号",
  order: "顺序",
};

/** 换书或重新解析后回到折叠状态，避免上一本展开后新书一次渲染几百条。 */
watch(
  () => props.chapters,
  () => {
    expanded.value = false;
  },
);
</script>

<template>
  <section
    v-if="report.issueCount > 0"
    class="card chapter-warnings"
    data-test="chapter-warnings"
    aria-labelledby="chapter-warnings-title"
  >
    <header class="warnings-header">
      <h2 id="chapter-warnings-title" class="warnings-title">章节校验</h2>
      <span class="warnings-count">发现 {{ report.issueCount }} 个问题</span>
    </header>

    <p class="warnings-hint">
      检查到章节编号或标题异常。连续性条目可点击跳转，疑似标题可直接分章。
    </p>

    <ul v-if="visibleContinuity.length > 0" class="warnings-list">
      <li v-for="(issue, index) in visibleContinuity" :key="`c-${index}`">
        <button
          type="button"
          class="warning-item"
          :data-test="`warning-issue-${index}`"
          @click="emit('select-chapter', issue.chapterId)"
        >
          <span class="warning-kind">{{ KIND_LABEL[issue.kind] }}</span>
          <span class="warning-text">{{ issue.message }}</span>
        </button>
      </li>
    </ul>

    <ul v-if="visibleSuspected.length > 0" class="warnings-list">
      <li
        v-for="(item, index) in visibleSuspected"
        :key="`s-${index}`"
        class="warning-item warning-suspected"
      >
        <span class="warning-kind">疑似标题</span>
        <span class="warning-text">
          「{{ item.chapterTitle }}」第 {{ item.lineIndex + 1 }} 行：{{ item.text }}
        </span>
        <button
          type="button"
          class="btn btn-ghost warning-split"
          :data-test="`warning-split-${index}`"
          :aria-label="`分章「${item.chapterTitle}」第 ${item.lineIndex + 1} 行：${item.text}`"
          @click="emit('split-chapter', { chapterId: item.chapterId, lineIndex: item.lineIndex })"
        >
          分章
        </button>
      </li>
    </ul>

    <button
      v-if="hiddenCount > 0"
      type="button"
      class="btn btn-ghost warnings-more"
      data-test="warning-more"
      @click="expanded = true"
    >
      显示全部（还有 {{ hiddenCount }} 条）
    </button>
  </section>
</template>
