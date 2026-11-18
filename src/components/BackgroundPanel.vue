<script setup lang="ts">
import { computed, ref } from "vue";
import type { BackgroundConfig, BackgroundPresetId } from "../core/render/layout";

const props = withDefaults(
  defineProps<{
    background: BackgroundConfig;
    /** 墨水屏等不使用背景图的主题。 */
    disabled?: boolean;
    /** 正在上传并转换背景图。 */
    busy?: boolean;
    /** 上传失败的中文提示。 */
    error?: string;
    /** 自定义背景的缩略图地址（data URL 或 object URL）。 */
    previewSrc?: string;
  }>(),
  {
    disabled: false,
    busy: false,
    error: "",
    previewSrc: undefined,
  },
);

const emit = defineEmits<{
  "select-preset": [id: BackgroundPresetId];
  upload: [file: File];
  clear: [];
}>();

interface PresetOption {
  id: BackgroundPresetId;
  label: string;
  hint: string;
}

const PRESETS: PresetOption[] = [
  { id: "paper", label: "纸纹", hint: "米色斜纹" },
  { id: "grid", label: "网格", hint: "浅灰方格" },
  { id: "dots", label: "点阵", hint: "均匀圆点" },
  { id: "linen", label: "亚麻", hint: "交叉织纹" },
];

const fileInput = ref<HTMLInputElement | null>(null);

const locked = computed<boolean>(() => props.disabled || props.busy);
const isCustom = computed<boolean>(() => props.background.kind === "custom");

function isSelected(id: BackgroundPresetId): boolean {
  return props.background.kind === "preset" && props.background.presetId === id;
}

function selectPreset(id: BackgroundPresetId): void {
  if (locked.value) return;
  emit("select-preset", id);
}

function openPicker(): void {
  if (locked.value) return;
  fileInput.value?.click();
}

function onPick(event: Event): void {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  // 清空 value，保证再次选择同一个文件也能触发 change。
  target.value = "";
  if (file && !locked.value) emit("upload", file);
}

/** 剪贴板里的图片转成 File 后交给父级；非图片内容保持浏览器默认行为。 */
function onPaste(event: ClipboardEvent): void {
  if (locked.value) return;
  const items = event.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (!file) continue;
    event.preventDefault();
    emit("upload", file);
    return;
  }
}

function clear(): void {
  // 上传过程中也允许清除：取消在途转换并丢弃结果。
  if (props.disabled) return;
  emit("clear");
}
</script>

<template>
  <section
    class="background-panel"
    data-test="background-panel"
    :aria-busy="busy ? 'true' : 'false'"
  >
    <div class="background-header">
      <h3 class="background-title">背景</h3>
      <p class="background-hint">
        内置纹理不增加文件体积；自定义图片会嵌入导出的电子书。
      </p>
    </div>

    <p
      v-if="disabled"
      class="background-notice"
      data-test="background-disabled-hint"
    >
      墨水屏主题不使用背景图，切换到其它主题后可选择背景。
    </p>

    <div class="background-presets" role="group" aria-label="内置背景">
      <button
        v-for="preset in PRESETS"
        :key="preset.id"
        type="button"
        class="background-preset"
        :class="{ 'background-preset-selected': isSelected(preset.id) }"
        :data-test="`background-preset-${preset.id}`"
        :aria-pressed="isSelected(preset.id) ? 'true' : 'false'"
        :disabled="locked"
        @click="selectPreset(preset.id)"
      >
        <span
          class="bg-swatch"
          :class="`bg-swatch-${preset.id}`"
          aria-hidden="true"
        ></span>
        <span class="background-preset-label">{{ preset.label }}</span>
        <span class="background-preset-hint">{{ preset.hint }}</span>
      </button>
    </div>

    <div class="background-custom">
      <input
        ref="fileInput"
        class="background-file"
        data-test="background-file"
        type="file"
        accept="image/*"
        tabindex="-1"
        :disabled="locked"
        @change="onPick"
      />
      <button
        type="button"
        class="btn"
        data-test="background-upload"
        :disabled="locked"
        @click="openPicker"
      >
        选择图片
      </button>
      <button
        v-if="background.kind !== 'none' || busy"
        type="button"
        class="btn btn-ghost"
        data-test="background-clear"
        :disabled="disabled"
        @click="clear"
      >
        清除背景
      </button>
    </div>

    <div
      class="background-paste"
      :class="{ 'background-paste-disabled': locked }"
      data-test="background-paste"
      role="group"
      aria-label="粘贴背景图"
      :tabindex="locked ? -1 : 0"
      :aria-disabled="locked ? 'true' : 'false'"
      @paste="onPaste"
    >
      选中这里后粘贴图片（Ctrl+V）
    </div>

    <p v-if="busy" class="loading" role="status" data-test="background-busy">
      正在处理背景图
    </p>

    <p v-if="error" class="background-error" role="alert" data-test="background-error">
      {{ error }}
    </p>

    <figure v-if="isCustom && previewSrc" class="background-preview">
      <img :src="previewSrc" alt="自定义背景预览" data-test="background-preview" />
    </figure>

    <p
      v-else-if="isCustom"
      class="background-selected"
      data-test="background-selected"
    >
      已选择背景图
    </p>
  </section>
</template>
