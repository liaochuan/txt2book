<script setup lang="ts">
import { computed, ref } from "vue";
import type { BookSession } from "../composables/useBookSession";
import {
  ENCODING_OPTIONS,
  useImport,
  type SourceEncoding,
} from "../composables/useImport";
import { loadRules, type ChapterRule } from "../core/customRules";

const props = defineProps<{ session: BookSession; rules?: ChapterRule[] }>();

const {
  fileName,
  detectedEncoding,
  usedEncoding,
  rawBytes,
  rules,
  busy,
  error,
  importFile,
  reparse: runReparse,
} = useImport(props.session);

const encoding = ref<SourceEncoding>("auto");
const dragDepth = ref(0);
const notice = ref("");
const fileInput = ref<HTMLInputElement | null>(null);

/** 导入/重新解析后章节的指纹，用于判断用户是否改过名或删过章。 */
function fingerprint(): string[] {
  return props.session.book.value.chapters.map(
    (chapter) => `${chapter.id}\u0000${chapter.title}`,
  );
}

const baseline = ref<string[] | null>(
  props.session.hasBook.value ? fingerprint() : null,
);

const hasFile = computed<boolean>(() => rawBytes.value !== null);
const canReparse = computed<boolean>(() => hasFile.value && !busy.value);
const dragging = computed<boolean>(() => dragDepth.value > 0);
const edited = computed<boolean>(() => {
  if (!hasFile.value) return false;
  const snapshot = baseline.value;
  if (!snapshot) return false;
  const current = fingerprint();
  return (
    current.length !== snapshot.length ||
    current.some((item, index) => item !== snapshot[index])
  );
});

/** 面板可以接收外部规则（来自 CustomRulesPanel），否则读取已保存的规则。 */
function currentRules(): ChapterRule[] {
  return props.rules ? [...props.rules] : loadRules();
}

async function startImport(file: File): Promise<void> {
  if (busy.value) {
    notice.value = "正在解析，请稍候。";
    return;
  }

  notice.value = "";
  rules.value = currentRules();
  let imported = false;
  try {
    imported = await importFile(file, encoding.value);
  } finally {
    // 上一次解析结束后，busy 期间产生的排队提示也随之失效。
    notice.value = "";
  }

  if (!imported) return;
  baseline.value = fingerprint();
  // 新文件回到自动识别，避免沿用上一个文件的手动编码造成乱码。
  encoding.value = "auto";
}

/** 拖入文件夹时浏览器也会触发 drop，这里提前识别并给出提示。 */
function containsDirectory(transfer: DataTransfer): boolean {
  const items = transfer.items;
  if (!items) return false;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.kind !== "file") continue;
    if (item.webkitGetAsEntry?.()?.isDirectory) return true;
  }
  return false;
}

function onDragEnter(): void {
  dragDepth.value += 1;
}

function onDragLeave(): void {
  dragDepth.value = Math.max(0, dragDepth.value - 1);
}

function onDrop(event: DragEvent): void {
  dragDepth.value = 0;
  const transfer = event.dataTransfer;
  if (transfer && containsDirectory(transfer)) {
    notice.value = "暂不支持文件夹，请选择 TXT 文件。";
    return;
  }
  const file = transfer?.files?.[0];
  if (file) void startImport(file);
}

function onPick(event: Event): void {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  // 清空 value，保证再次选择同一个文件也能触发 change。
  target.value = "";
  if (file) void startImport(file);
}

async function reparse(): Promise<void> {
  if (!canReparse.value) return;
  if (
    edited.value &&
    !window.confirm(
      "重新解析：书籍信息会保留，但章节编辑（改名/删除）会被丢弃，是否继续？",
    )
  ) {
    return;
  }
  notice.value = "";
  try {
    await runReparse(encoding.value, currentRules());
  } finally {
    notice.value = "";
  }
  if (!error.value) baseline.value = fingerprint();
}
</script>

<template>
  <section class="card upload-panel" :aria-busy="busy ? 'true' : 'false'">
    <header class="upload-header">
      <h2 class="upload-title">导入 TXT</h2>
      <p class="upload-hint">拖入文件或点击选择，文件只在本地解析，不会上传。</p>
    </header>

    <div
      class="upload-drop"
      :class="{ 'upload-drop-active': dragging }"
      data-test="drop-zone"
      @dragenter.prevent="onDragEnter"
      @dragover.prevent
      @dragleave.prevent="onDragLeave"
      @drop.prevent="onDrop"
    >
      <p class="upload-drop-text">把 TXT 文件拖到这里</p>
      <input
        ref="fileInput"
        class="upload-file"
        data-test="file-input"
        type="file"
        accept=".txt,text/plain"
        tabindex="-1"
        :disabled="busy"
        @change="onPick"
      />
      <button
        type="button"
        class="btn btn-primary"
        data-test="pick-file"
        :disabled="busy"
        @click="fileInput?.click()"
      >
        <span v-if="busy" class="loading" data-test="busy">正在解析</span>
        <span v-else>选择文件</span>
      </button>
      <p v-if="fileName" class="upload-file-name" data-test="file-name">
        {{ fileName }}
      </p>
    </div>

    <div class="field upload-encoding">
      <label for="upload-encoding">编码</label>
      <select
        id="upload-encoding"
        v-model="encoding"
        data-test="encoding"
        :disabled="busy"
      >
        <option
          v-for="option in ENCODING_OPTIONS"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }}
        </option>
      </select>
      <p class="upload-encoding-hint" data-test="encoding-hint">
        切换后需点击“重新解析”生效
      </p>
    </div>

    <p class="upload-meta">
      <span v-if="detectedEncoding" data-test="detected-encoding">
        自动检测：{{ detectedEncoding }}
      </span>
      <span v-if="usedEncoding" data-test="used-encoding">
        实际使用：{{ usedEncoding }}
      </span>
      <span v-if="!hasFile" data-test="no-file">尚未导入文件</span>
    </p>

    <p v-if="edited" class="upload-warning" data-test="edited-warning">
      章节已被编辑，重新解析会覆盖这些改动，可通过撤销恢复。
    </p>

    <p v-if="error" class="upload-error" role="alert" data-test="error">
      {{ error }}
    </p>

    <p v-if="notice" class="upload-notice" role="status" data-test="notice">
      {{ notice }}
    </p>

    <div class="upload-actions">
      <button
        type="button"
        class="btn"
        data-test="reparse"
        :disabled="!canReparse"
        @click="reparse"
      >
        重新解析
      </button>
    </div>
  </section>
</template>
