<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { listConverters } from "../core/converters";
import type { ConverterMeta, ConvertOptions, FormatOption } from "../core/converters/types";

const props = withDefaults(
  defineProps<{
    /** 默认取已注册的转换器；测试可注入不可用格式。 */
    converters?: ConverterMeta[];
    /** 导出进行中：禁用按钮并显示加载文案。 */
    busy?: boolean;
    /** 没有可导出的章节时由父级禁用。 */
    disabled?: boolean;
    /** 禁用原因；为空时使用默认提示。 */
    hint?: string;
  }>(),
  {
    converters: () => listConverters(),
    busy: false,
    disabled: false,
    hint: "",
  },
);

const emit = defineEmits<{
  export: [request: { format: string; options: ConvertOptions }];
}>();

const formats = computed<ConverterMeta[]>(() => props.converters);
const firstAvailable = formats.value.find((item) => item.available) ?? formats.value[0];
const format = ref(firstAvailable?.id ?? "");

const includeTocPage = ref(false);
const includeTitlePage = ref(false);
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

const blockedReason = computed<string>(() => {
  if (!props.disabled) return "";
  return props.hint || "导入 TXT 并生成章节后才能导出。";
});

const canExport = computed<boolean>(
  () => !props.busy && !props.disabled && selected.value?.available === true,
);

function options(): ConvertOptions {
  const result: ConvertOptions = {
    includeTocPage: includeTocPage.value,
    includeTitlePage: includeTitlePage.value,
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
</script>

<template>
  <section class="card export-panel" data-test="export-panel" :aria-busy="busy ? 'true' : 'false'">
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
        :disabled="!item.available || busy"
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
            v-model="includeTitlePage"
            data-test="opt-title"
            type="checkbox"
            aria-describedby="hint-title"
            :disabled="busy"
          />
          <span>生成书名页</span>
        </label>
        <p id="hint-title" class="option-hint" data-test="hint-title">
          在封面后插入书名与作者页；有简介时仍会单独生成简介页。关闭后直接从正文开始。
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
      <span v-if="busy" class="loading">正在生成 {{ selected ? selected.label : "" }}</span>
      <span v-else>导出 {{ selected ? selected.label : "" }}</span>
    </button>
  </section>
</template>
