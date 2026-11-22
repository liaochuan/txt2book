<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { listConverters } from "../core/converters";
import type {
  ConverterMeta,
  ConvertOptions,
  ExportProgress,
  FormatOption,
} from "../core/converters/types";
import type { CalibrePushMode } from "../types/calibre";

const props = withDefaults(
  defineProps<{
    /** 默认取已注册的转换器；测试可注入不可用格式。 */
    converters?: ConverterMeta[];
    /** 导出进行中：禁用按钮并显示加载文案。 */
    busy?: boolean;
    /** 当前导出进度；`busy` 时显示在按钮下方。 */
    progress?: ExportProgress | null;
    /** 没有可导出的章节时由父级禁用。 */
    disabled?: boolean;
    /** 禁用原因；为空时使用默认提示。 */
    hint?: string;
    /** 当前书籍关联到可推送的 Calibre-Web 实例。 */
    canPush?: boolean;
    /** 导出 EPUB 时的推送模式；由父级持有。 */
    pushMode?: CalibrePushMode;
    /** 推送目标书名，用于提示。 */
    calibreTitle?: string;
    /** 关联书籍已有 EPUB：提示推送会覆盖。 */
    hasEpub?: boolean;
    /** 推送进行中：禁用导出并显示推送进度。 */
    pushing?: boolean;
  }>(),
  {
    converters: () => listConverters(),
    busy: false,
    progress: null,
    disabled: false,
    hint: "",
    canPush: false,
    pushMode: "off",
    calibreTitle: "",
    hasEpub: false,
    pushing: false,
  },
);

const emit = defineEmits<{
  export: [request: { format: string; options: ConvertOptions }];
  "update:pushMode": [value: CalibrePushMode];
}>();

const formats = computed<ConverterMeta[]>(() => props.converters);
const firstAvailable = formats.value.find((item) => item.available) ?? formats.value[0];
const format = ref(firstAvailable?.id ?? "");

const includeTocPage = ref(false);
const includeDescription = ref(false);
const includeVolumePages = ref(false);

const selected = computed<ConverterMeta | null>(
  () => formats.value.find((item) => item.id === format.value) ?? null,
);

const formatOptions = computed<FormatOption[]>(() => selected.value?.options ?? []);

/** 服务端格式自带目录选项时隐藏通用开关，避免两个入口互相覆盖。 */
const showContentToc = computed<boolean>(() => selected.value?.runtime !== "server");

/** 服务端格式会上传书籍内容，不能沿用“浏览器本地生成”的说明。 */
const headerHint = computed<string>(() =>
  selected.value?.runtime === "server"
    ? "该格式由服务器生成，书籍内容会发送到服务器。"
    : "文件在浏览器本地生成，不会上传到服务器。",
);

/** 只有 EPUB 能推送回 calibre-web；其它格式不展示推送选项。 */
const showPush = computed<boolean>(() => props.canPush && selected.value?.id === "epub");

/** 当前格式的选项值；切换格式时整体替换，避免旧格式的值串到新格式。 */
const formatValues = ref<Record<string, boolean | string>>({});

function defaultsFor(meta: ConverterMeta | null): Record<string, boolean | string> {
  const values: Record<string, boolean | string> = {};
  for (const option of meta?.options ?? []) values[option.key] = option.defaultValue;
  return values;
}

watch(
  selected,
  (meta) => {
    formatValues.value = defaultsFor(meta);
  },
  { immediate: true },
);

function setFormatValue(key: string, value: boolean | string): void {
  formatValues.value = { ...formatValues.value, [key]: value };
}

function onBooleanChange(key: string, event: Event): void {
  setFormatValue(key, (event.target as HTMLInputElement).checked);
}

function onSelectChange(key: string, event: Event): void {
  setFormatValue(key, (event.target as HTMLSelectElement).value);
}

function onPushModeChange(event: Event): void {
  emit("update:pushMode", (event.target as HTMLSelectElement).value as CalibrePushMode);
}

const blockedReason = computed<string>(() => {
  if (!props.disabled) return "";
  return props.hint || "导入 TXT 并生成章节后才能导出。";
});

const canExport = computed<boolean>(
  () =>
    !props.busy &&
    !props.pushing &&
    !props.disabled &&
    selected.value?.available === true,
);

function options(): ConvertOptions {
  const result: ConvertOptions = {
    includeTocPage: includeTocPage.value,
    includeDescription: includeDescription.value,
    includeVolumePages: includeVolumePages.value,
  };
  // 没有格式专属选项时不写空对象，保持既有 payload 形状。
  if (formatOptions.value.length > 0) {
    result.formatOptions = { ...formatValues.value };
  }
  return result;
}

function submit(): void {
  if (!canExport.value) return;
  emit("export", { format: format.value, options: options() });
}

/** 已用时间按秒累加；仅在 busy 期间计时，结束后立即清理。 */
const elapsedSeconds = ref(0);
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

function stopElapsedTimer(): void {
  if (elapsedTimer === null) return;
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

watch(
  () => props.busy,
  (busy) => {
    stopElapsedTimer();
    elapsedSeconds.value = 0;
    if (!busy) return;
    elapsedTimer = setInterval(() => {
      elapsedSeconds.value += 1;
    }, 1000);
  },
  { immediate: true },
);

onBeforeUnmount(stopElapsedTimer);
</script>

<template>
  <section
    class="card export-panel"
    data-test="export-panel"
    :aria-busy="busy || pushing ? 'true' : 'false'"
  >
    <header class="export-header">
      <h2 class="export-title">导出</h2>
      <p class="export-hint" data-test="export-hint">{{ headerHint }}</p>
    </header>

    <div class="export-formats" role="radiogroup" aria-label="导出格式">
      <button
        v-for="item in formats"
        :key="item.id"
        type="button"
        class="export-format"
        :class="{ 'export-format-selected': item.id === format }"
        role="radio"
        :aria-checked="item.id === format ? 'true' : 'false'"
        :disabled="!item.available || busy || pushing"
        :data-test="`format-${item.id}`"
        @click="format = item.id"
      >
        <span class="export-format-name">{{ item.label }}</span>
        <span v-if="item.available" class="export-format-ext">.{{ item.extension }}</span>
        <span v-else class="export-format-badge">即将支持</span>
      </button>
    </div>

    <fieldset class="export-options">
      <legend class="export-options-title">内容选项</legend>

      <div v-if="showContentToc" class="export-option-field">
        <label class="export-option">
          <input
            v-model="includeTocPage"
            data-test="opt-toc"
            type="checkbox"
            aria-describedby="hint-toc"
            :disabled="busy"
          />
          <span>生成目录页</span>
        </label>
        <p id="hint-toc" class="option-hint" data-test="hint-toc">
          在正文前插入一页可翻阅的目录。关闭后阅读器自带的导航目录仍然可用，只是书里不出现目录页。
        </p>
      </div>

      <div class="export-option-field">
        <label class="export-option">
          <input
            v-model="includeDescription"
            data-test="opt-description"
            type="checkbox"
            aria-describedby="hint-description"
            :disabled="busy"
          />
          <span>生成简介页</span>
        </label>
        <p id="hint-description" class="option-hint" data-test="hint-description">
          有简介时在正文前插入简介页；关闭后书籍元数据里仍保留简介，只是书里不出现简介页。
        </p>
      </div>

      <div class="export-option-field">
        <label class="export-option">
          <input
            v-model="includeVolumePages"
            data-test="opt-volume"
            type="checkbox"
            aria-describedby="hint-volume"
            :disabled="busy"
          />
          <span>生成卷扉页</span>
        </label>
        <p id="hint-volume" class="option-hint" data-test="hint-volume">
          为每个卷生成独立标题页，并展示卷首文字。关闭后卷首文字会以居中样式并入该卷第一章开头，不会丢失。
        </p>
      </div>
    </fieldset>

    <fieldset v-if="formatOptions.length > 0" class="export-options" data-test="format-options">
      <legend class="export-options-title">格式选项</legend>

      <div v-for="option in formatOptions" :key="option.key" class="export-option-field">
        <label v-if="option.type === 'boolean'" class="export-option">
          <input
            type="checkbox"
            :checked="formatValues[option.key] === true"
            :aria-describedby="option.hint ? `format-opt-hint-${option.key}` : undefined"
            :disabled="busy"
            :data-test="`format-opt-${option.key}`"
            @change="onBooleanChange(option.key, $event)"
          />
          <span>{{ option.label }}</span>
        </label>

        <label v-else class="export-option">
          <span>{{ option.label }}</span>
          <select
            class="export-select"
            :aria-describedby="option.hint ? `format-opt-hint-${option.key}` : undefined"
            :disabled="busy"
            :data-test="`format-opt-${option.key}`"
            @change="onSelectChange(option.key, $event)"
          >
            <option
              v-for="choice in option.choices ?? []"
              :key="choice.value"
              :value="choice.value"
              :selected="formatValues[option.key] === choice.value"
            >
              {{ choice.label }}
            </option>
          </select>
        </label>

        <p
          v-if="option.hint"
          :id="`format-opt-hint-${option.key}`"
          class="option-hint"
          :data-test="`format-opt-hint-${option.key}`"
        >
          {{ option.hint }}
        </p>
      </div>
    </fieldset>

    <fieldset v-if="showPush" class="export-options" data-test="push-options">
      <legend class="export-options-title">Calibre-Web</legend>

      <div class="export-option-field">
        <label class="export-option export-push-mode">
          <span>推送方式</span>
          <select
            class="export-select"
            data-test="push-mode"
            :value="pushMode"
            :disabled="busy || pushing"
            :aria-describedby="hasEpub ? 'push-overwrite-warning' : undefined"
            @change="onPushModeChange"
          >
            <option value="off">不推送</option>
            <option value="download-and-push">下载并推送</option>
            <option value="push-only">仅推送（不下载）</option>
          </select>
        </label>
        <p
          v-if="hasEpub"
          id="push-overwrite-warning"
          class="option-hint"
          data-test="push-overwrite-warning"
        >
          该书已有 EPUB，推送会覆盖原文件
        </p>
        <p v-else-if="calibreTitle" class="option-hint" data-test="push-target">
          目标：《{{ calibreTitle }}》
        </p>
        <p
          v-if="showPush && pushMode === 'push-only'"
          class="option-hint"
          data-test="push-only-hint"
        >
          仅推送到 Calibre-Web，不会下载本地文件。
        </p>
      </div>
    </fieldset>

    <p v-if="blockedReason" id="export-blocked-hint" class="export-blocked" data-test="export-blocked">
      {{ blockedReason }}
    </p>

    <button
      type="button"
      class="btn btn-primary export-submit"
      data-test="export"
      :disabled="!canExport"
      :aria-describedby="blockedReason ? 'export-blocked-hint' : undefined"
      @click="submit"
    >
      <span v-if="pushing" class="loading">正在推送</span>
      <span v-else-if="busy" class="loading">正在生成 {{ selected ? selected.label : "" }}</span>
      <span v-else-if="showPush && pushMode === 'push-only'">
        仅推送 {{ selected ? selected.label : "" }}
      </span>
      <span v-else>导出 {{ selected ? selected.label : "" }}</span>
    </button>

    <p
      v-if="pushing"
      class="loading export-push-progress"
      role="status"
      data-test="export-push-progress"
    >
      正在推送到 Calibre-Web…
    </p>

    <div
      v-if="busy"
      class="export-progress"
      data-test="export-progress"
    >
      <progress
        class="export-progress-bar"
        max="100"
        aria-label="导出进度"
        :value="progress?.percent ?? undefined"
      ></progress>
      <div class="export-progress-text">
        <span
          class="export-progress-message"
          data-test="export-progress-message"
          aria-live="polite"
        >
          {{ progress?.message ?? "正在导出…" }}
        </span>
        <span
          class="export-progress-elapsed"
          data-test="export-progress-elapsed"
          aria-hidden="true"
        >
          已用 {{ elapsedSeconds }}s
        </span>
      </div>
    </div>
  </section>
</template>
