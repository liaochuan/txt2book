<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { layoutCss, type LayoutSettings } from "../core/render/layout";
import {
  renderChapterBody,
  renderPreviewDocument,
  renderVolumeBody,
  renderVolumePreviewDocument,
} from "../core/render/renderChapter";
import { DEFAULT_THEME_ID, themes } from "../core/render/themes";
import type { Theme } from "../core/render/themes";
import type { Chapter, ThemeId, Volume } from "../types/book";

const props = defineProps<{
  chapter: Chapter | null;
  allChapters: Chapter[];
  themeId: ThemeId;
  /** 高级排版配置；与导出共用 `layoutCss()` 生成 CSS。 */
  layout: LayoutSettings;
  /** 自定义背景的预览地址（data URL）；预设背景不需要。 */
  backgroundSrc?: string;
  /** 连页预览按 spine 顺序插入卷扉页；不传时视为没有卷。 */
  volumes?: Volume[];
  /** 选中的卷；非空时预览卷扉页，优先于章节。 */
  volume?: Volume | null;
  /** 卷内第一章 id，「回到章节」按钮使用；卷内没有章节时为空。 */
  volumeFirstChapterId?: string | null;
}>();

const emit = defineEmits<{
  /**
   * 主题选择的入口在独立的 `ThemePicker`，预览面板不重复渲染选择器；
   * 该事件只为将来把主题选择内嵌进预览面板预留。
   */
  "update:themeId": [id: ThemeId];
  /** 翻页时通知父级同步选中，Task 7 会接到 `session.select`。 */
  "select-chapter": [id: string];
}>();

/** `renderPreviewDocument` 输出的 body 开标签，用于连页模式替换正文。 */
const BODY_PATTERN = /(<body class="txt2book">)[\s\S]*(<\/body>)/;

/** 连页预览专用的章节分隔线；导出 XHTML 目前没有同名结构。 */
const CHAPTER_SEPARATOR = '<hr class="chapter-sep">';

const continuous = ref(false);
/** 单章模式当前展示的章节 id；点击目录时由外部 `chapter` 同步。 */
const activeId = ref<string | null>(props.chapter?.id ?? null);

/** 没有 `chapter` 时不预览；`allChapters` 缺失时退化为只有当前章。 */
const chapters = computed<Chapter[]>(() => {
  if (!props.chapter) return [];
  return props.allChapters.length > 0 ? props.allChapters : [props.chapter];
});

const currentChapter = computed<Chapter | null>(() => {
  const list = chapters.value;
  if (list.length === 0) return null;
  return list.find((chapter) => chapter.id === activeId.value) ?? props.chapter ?? list[0] ?? null;
});

const positionIndex = computed<number>(() => {
  const current = currentChapter.value;
  if (!current) return -1;
  return chapters.value.findIndex((chapter) => chapter.id === current.id);
});

const positionLabel = computed<string>(() => {
  const total = chapters.value.length;
  const index = positionIndex.value;
  return `第 ${index >= 0 ? index + 1 : 1} / ${total} 章`;
});

const canPrev = computed<boolean>(() => positionIndex.value > 0);
const canNext = computed<boolean>(
  () => positionIndex.value >= 0 && positionIndex.value < chapters.value.length - 1,
);

const activeTheme = computed<Theme>(() => themes[props.themeId] ?? themes[DEFAULT_THEME_ID]);

/** 卷扉页优先于章节预览；卷内没有章节时仍可预览卷首文字。 */
const activeVolume = computed<Volume | null>(() => props.volume ?? null);

/** 高级排版 CSS 必须排在主题 CSS 之后，覆盖同特异度的主题规则。 */
const extraCss = computed<string>(() =>
  layoutCss(props.themeId, props.layout, { backgroundSrc: props.backgroundSrc }),
);

const iframeTitle = computed<string>(() => {
  const volume = activeVolume.value;
  if (volume) return `卷预览：${volume.title}`;
  if (continuous.value) return "全书连页预览";
  const current = currentChapter.value;
  return current ? `章节预览：${current.title}` : "章节预览";
});

/** 多章共用同一份文档壳（含主题 CSS），正文按顺序拼接。 */
function renderContinuousDocument(list: Chapter[], theme: Theme): string {
  const first = list[0];
  if (!first) return "";

  const volumeById = new Map((props.volumes ?? []).map((volume) => [volume.id, volume]));
  const emitted = new Set<string>();
  // 卷扉页与其第一章放在同一块里，避免中间多出一条章节分隔线。
  const blocks: string[] = list.map((chapter) => {
    const volume =
      chapter.volumeId === null ? undefined : volumeById.get(chapter.volumeId);
    const body = renderChapterBody(chapter, theme);
    if (!volume || volume.kind !== "volume" || emitted.has(volume.id)) return body;
    emitted.add(volume.id);
    return `${renderVolumeBody(volume)}\n${body}`;
  });

  const body = blocks.join(`\n${CHAPTER_SEPARATOR}\n`);
  return renderPreviewDocument(first, theme, { extraCss: extraCss.value }).replace(
    BODY_PATTERN,
    (_match, open: string, close: string) => `${open}\n${body}\n${close}`,
  );
}

const srcdoc = computed<string>(() => {
  const volume = activeVolume.value;
  const theme = activeTheme.value;
  if (volume) {
    return renderVolumePreviewDocument(volume, theme, { extraCss: extraCss.value });
  }
  const list = chapters.value;
  if (list.length === 0) return "";
  if (continuous.value) return renderContinuousDocument(list, theme);
  const current = currentChapter.value;
  return current
    ? renderPreviewDocument(current, theme, { extraCss: extraCss.value })
    : "";
});

/** 点击目录切换章节时，预览跟随到同一章。 */
watch(
  () => props.chapter?.id,
  (id) => {
    if (id) activeId.value = id;
  },
);

/** 章节被删除、重排或重命名时，尽量保留用户正在预览的那一章。 */
watch(
  () => props.allChapters,
  () => {
    const list = chapters.value;
    if (list.some((chapter) => chapter.id === activeId.value)) return;
    const fallback = list.find((chapter) => chapter.id === props.chapter?.id) ?? list[0];
    activeId.value = fallback?.id ?? null;
  },
);

/**
 * 翻页时同步更新内部当前章，并 emit `select-chapter` 通知父级。
 * Task 7 会把它接到 `session.select`，让父级选中成为唯一真相；
 * 父级回写 `chapter` 后，上面的 watch 会再次对齐 `activeId`。
 */
function go(step: number): void {
  const target = chapters.value[positionIndex.value + step];
  if (!target) return;
  activeId.value = target.id;
  emit("select-chapter", target.id);
}

function toggleContinuous(): void {
  continuous.value = !continuous.value;
}

/** 卷扉页的「回到章节」：仅在该卷有章节时可用。 */
function backToChapter(): void {
  const id = props.volumeFirstChapterId;
  if (!id) return;
  emit("select-chapter", id);
}
</script>

<template>
  <section id="preview-pane" class="card preview-pane" data-test="preview-pane">
    <header class="preview-header">
      <div class="preview-heading">
        <h2 class="preview-title">预览</h2>
        <p class="preview-hint">预览与导出的电子书使用同一套排版。</p>
      </div>
    </header>

    <div v-if="activeVolume || currentChapter" class="preview-toolbar" role="toolbar" aria-label="预览控制">
      <template v-if="activeVolume">
        <span class="preview-position preview-volume-label" data-test="preview-volume-label">
          卷 · {{ activeVolume.title }}
        </span>
        <button
          v-if="volumeFirstChapterId"
          type="button"
          class="btn btn-ghost preview-back"
          data-test="preview-back-chapter"
          @click="backToChapter"
        >
          回到章节
        </button>
      </template>

      <template v-else>
        <template v-if="!continuous">
          <button
            type="button"
            class="btn btn-ghost preview-step"
            data-test="preview-prev"
            :disabled="!canPrev"
            @click="go(-1)"
          >
            上一章
          </button>
          <button
            type="button"
            class="btn btn-ghost preview-step"
            data-test="preview-next"
            :disabled="!canNext"
            @click="go(1)"
          >
            下一章
          </button>
        </template>

        <span class="preview-position" data-test="preview-position">{{ positionLabel }}</span>

        <button
          type="button"
          class="btn preview-mode"
          :class="{ 'preview-mode-active': continuous }"
          data-test="preview-continuous"
          :aria-pressed="continuous ? 'true' : 'false'"
          title="把所有章节连成一页预览"
          @click="toggleContinuous"
        >
          连页
        </button>
      </template>
    </div>

    <div v-if="!activeVolume && !currentChapter" class="preview-empty" data-test="preview-empty">
      <p class="preview-empty-title">还没有可预览的章节</p>
      <p class="preview-empty-hint">
        先在左侧「导入 TXT」，导入后可在这里查看章节的排版效果。
      </p>
    </div>

    <div v-else class="preview-frame">
      <iframe
        class="preview-iframe"
        data-test="preview-iframe"
        :title="iframeTitle"
        :srcdoc="srcdoc"
        sandbox=""
      ></iframe>
    </div>
  </section>
</template>
