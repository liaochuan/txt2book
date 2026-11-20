<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { BookSession } from "../composables/useBookSession";
import {
  measureImageSize,
  useCover,
  type ImageSize,
  type UseCover,
} from "../composables/useCover";

const props = defineProps<{ session: BookSession; controller?: UseCover }>();

const controller = props.controller ?? useCover(props.session);
// 注入了外部 controller 时由父级负责释放；只有自己创建的才在卸载时 dispose。
const ownsController = props.controller === undefined;
const { cover, previewUrl, busy, error, fromUrl, fromFile, clear, dispose } =
  controller;

const URL_PROTOCOL_ERROR = "仅支持 http/https 图片地址";

const url = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
/** 本地文件的原图尺寸；URL 来源与撤销恢复的封面无法获知，保持 0×0。 */
const original = ref<ImageSize>({ width: 0, height: 0 });

const canFetch = computed<boolean>(() => url.value.trim() !== "" && !busy.value);
const sizeLabel = computed<string>(() => {
  const asset = cover.value;
  if (!asset) return "";
  const png = `PNG ${asset.width}×${asset.height}`;
  // 不知道原图尺寸时只报转换后的 PNG 尺寸，避免展示误导性的 0×0。
  if (original.value.width <= 0 || original.value.height <= 0) return png;
  return `原图 ${original.value.width}×${original.value.height} → ${png}`;
});

// 外部换封面（撤销、导入）时清掉上一张的原图尺寸，避免尺寸说明张冠李戴。
watch(
  cover,
  () => {
    original.value = { width: 0, height: 0 };
  },
  { flush: "sync" },
);

function clearError(): void {
  if (error.value !== "") error.value = "";
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function fetchFromUrl(): Promise<void> {
  if (!canFetch.value) return;
  const target = url.value.trim();
  if (!isHttpUrl(target)) {
    error.value = URL_PROTOCOL_ERROR;
    return;
  }
  await fromUrl(target);
}

async function pickFile(file: File): Promise<void> {
  if (busy.value) return;
  const size = await measureImageSize(file);
  const ok = await fromFile(file);
  // 失败时保留上一张封面及其尺寸说明。
  if (ok) original.value = size;
}

function onPick(event: Event): void {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  // 清空 value，保证再次选择同一个文件也能触发 change。
  target.value = "";
  if (file) void pickFile(file);
}

function onClear(): void {
  original.value = { width: 0, height: 0 };
  clear();
}

onBeforeUnmount(() => {
  if (ownsController) dispose();
});
</script>

<template>
  <section class="card cover-panel" :aria-busy="busy ? 'true' : 'false'">
    <header class="cover-header">
      <h2 class="cover-title">封面</h2>
      <p class="cover-hint">
        粘贴图片地址或选择本地图片，服务端统一转换为 PNG，不写入原始格式。
      </p>
    </header>

    <div class="cover-source">
      <div class="field cover-url">
        <label for="cover-url">图片地址</label>
        <input
          id="cover-url"
          v-model="url"
          data-test="cover-url"
          type="url"
          inputmode="url"
          placeholder="https://example.com/cover.jpg"
          autocomplete="off"
          :disabled="busy"
          @input="clearError"
          @keydown.enter.prevent="fetchFromUrl"
        />
      </div>
      <button
        type="button"
        class="btn btn-primary cover-fetch"
        data-test="fetch-cover"
        :disabled="!canFetch"
        @click="fetchFromUrl"
      >
        获取封面
      </button>
    </div>

    <div class="cover-actions">
      <input
        ref="fileInput"
        class="cover-file"
        data-test="cover-file"
        type="file"
        accept="image/*"
        tabindex="-1"
        :disabled="busy"
        @change="onPick"
      />
      <button
        type="button"
        class="btn"
        data-test="pick-cover"
        :disabled="busy"
        @click="fileInput?.click()"
      >
        选择文件
      </button>
      <button
        v-if="cover"
        type="button"
        class="btn btn-ghost"
        data-test="clear-cover"
        :disabled="busy"
        @click="onClear"
      >
        清除封面
      </button>
    </div>

    <p v-if="busy" class="loading" role="status" data-test="cover-busy">正在处理封面</p>

    <p v-if="error" class="cover-error" role="alert" data-test="cover-error">
      {{ error }}
    </p>

    <figure v-if="cover" class="cover-preview">
      <img
        v-if="previewUrl"
        :src="previewUrl"
        alt="封面预览"
        data-test="cover-preview"
      />
      <figcaption v-if="sizeLabel" class="cover-size" data-test="cover-size">
        {{ sizeLabel }}
      </figcaption>
    </figure>

    <p v-else-if="!busy" class="cover-empty" data-test="cover-empty">
      尚未设置封面，导出的电子书将不带封面图片。
    </p>
  </section>
</template>
