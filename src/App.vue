<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import BookMetaPanel from "./components/BookMetaPanel.vue";
import BackgroundPanel from "./components/BackgroundPanel.vue";
import ChapterTree from "./components/ChapterTree.vue";
import CoverPanel from "./components/CoverPanel.vue";
import CustomRulesPanel from "./components/CustomRulesPanel.vue";
import ExportPanel from "./components/ExportPanel.vue";
import LoginView from "./components/LoginView.vue";
import PreviewPane from "./components/PreviewPane.vue";
import ThemePicker from "./components/ThemePicker.vue";
import ToastStack from "./components/ToastStack.vue";
import TypographyPanel from "./components/TypographyPanel.vue";
import UploadPanel from "./components/UploadPanel.vue";
import { useAuth } from "./composables/useAuth";
import { useBackgroundImage } from "./composables/useBackgroundImage";
import { useBookSession, type BookSession } from "./composables/useBookSession";
import { useLayoutSettings } from "./composables/useLayoutSettings";
import { useThemePreference } from "./composables/useThemePreference";
import { useToasts } from "./composables/useToasts";
import { setUnauthorizedHandler } from "./core/api";
import { converterRegistry, listConverters } from "./core/converters";
import type { ConvertOptions } from "./core/converters/types";
import { loadRules, type ChapterRule } from "./core/customRules";
import { downloadBlob } from "./core/download";
import { buildExportFileName } from "./core/exportFileName";
import { bytesToDataUrl } from "./core/imageDataUrl";
import type { BackgroundPresetId, ElementKey, ElementStyle } from "./core/render/layout";

/** 测试可注入会话；生产环境每个应用实例持有一份独立会话。 */
const props = defineProps<{ session?: BookSession }>();

const { authenticated, username, checking, check, logout, clearSession } = useAuth();
const session = props.session ?? useBookSession();
const {
  book,
  selected,
  selectedId,
  selectedVolumeId,
  selectedVolume,
  canUndo,
  hasBook,
  version,
  select,
  selectVolume,
  rename,
  removeChapter,
  removeVolume,
  undo,
  reset,
  updateMeta,
} = session;

/** 卷扉页「回到章节」的目标：该卷阅读顺序中的第一章。 */
const volumeFirstChapterId = computed<string | null>(() => {
  const volume = selectedVolume.value;
  if (!volume) return null;
  const chapter = book.value.chapters.find((item) => item.volumeId === volume.id);
  return chapter?.id ?? null;
});

const { toasts, push: pushToast, dismiss: dismissToast, action: runToastAction } = useToasts();

const { themeId, setTheme } = useThemePreference();
const {
  layout,
  setElement,
  setBackground,
  resetTypography,
} = useLayoutSettings(themeId);
const {
  busy: backgroundBusy,
  error: backgroundError,
  fromFile: uploadBackground,
  clear: clearBackground,
  cancel: cancelBackground,
} = useBackgroundImage(setBackground);
const rules = ref<ChapterRule[]>(loadRules());
const converters = listConverters();
const exporting = ref(false);

/** 自定义背景在预览 iframe 中使用的 data URL；其它情况保持为空。 */
const backgroundSrc = ref<string | undefined>(undefined);

/**
 * 自定义背景以 data URL 交给预览 iframe：空 `sandbox` 下 iframe 是不透明源，
 * 父页面的 `blob:` URL 会被跨源策略拒绝，`data:` URL 不受影响。
 *
 * 只在背景字节变化时重建：`setElement` 会重建 background 对象，
 * 但沿用同一份 `Uint8Array`，因此用数据引用判断即可避免每次改字号都重新编码。
 */
function syncBackgroundSrc(): void {
  const background = layout.value.background;
  if (background.kind !== "custom" || !background.custom) {
    backgroundSrc.value = undefined;
    return;
  }
  try {
    backgroundSrc.value = bytesToDataUrl(
      background.custom.data,
      background.custom.mimeType,
    );
  } catch {
    backgroundSrc.value = undefined;
  }
}

watch(
  () => {
    const background = layout.value.background;
    return background.kind === "custom" ? (background.custom?.data ?? null) : null;
  },
  syncBackgroundSrc,
  { immediate: true },
);

// 切换主题时中止仍在转换的背景图，避免结果被写进新主题的排版配置。
watch(themeId, cancelBackground, { flush: "sync" });

onBeforeUnmount(() => {
  cancelBackground();
});

function onUpdateElement(payload: { key: ElementKey; patch: Partial<ElementStyle> }): void {
  setElement(payload.key, payload.patch);
}

function onSelectPreset(id: BackgroundPresetId): void {
  setBackground({ kind: "preset", presetId: id });
}

function onUploadBackground(file: File): void {
  void uploadBackground(file);
}

const EXPORT_HINT = "导入 TXT 并生成章节后才能导出。";

/** 任意接口返回 401 时清空登录态与当前书籍；只有此前已登录才提示会话失效。 */
function handleUnauthorized(): void {
  const wasAuthenticated = authenticated.value;
  clearSession();
  // 与登出行为一致：会话失效后丢弃当前书籍，避免重新登录看到上一会话内容。
  reset();
  if (wasAuthenticated) {
    pushToast({
      message: "登录已失效，当前书籍已清空，请重新登录。",
      kind: "error",
    });
  }
}

setUnauthorizedHandler(handleUnauthorized);
onBeforeUnmount(() => setUnauthorizedHandler(null));

// 在 setup 阶段就发起会话检查：`checking` 同步置为 true，首屏直接显示校验占位，
// 不再额外维护 authReady，避免两套“已就绪”状态漂移。
void check();

async function onLogout(): Promise<void> {
  await logout();
  // 登出后书籍不再属于当前用户，重置避免下次登录看到上一会话内容。
  reset();
}

function onRulesChange(next: ChapterRule[]): void {
  rules.value = next;
}

function onRename(payload: { id: string; title: string }): void {
  rename(payload.id, payload.title);
}

/** 再次点击已选中的卷名时退出卷预览，回到章节（选中为空时回退到第一章）。 */
function onSelectVolume(id: string): void {
  if (selectedVolumeId.value === id) {
    select(null);
    return;
  }
  selectVolume(id);
}

/** 版本一致才允许撤销；否则说明中间有其它编辑，撤销会误伤。 */
function undoIfCurrent(actionVersion: number): void {
  if (version.value !== actionVersion) {
    pushToast({ message: "该操作已被后续编辑覆盖，无法撤销。", kind: "error" });
    return;
  }
  undo();
}

function onRemoveChapter(id: string): void {
  const chapter = book.value.chapters.find((item) => item.id === id);
  if (!chapter) {
    pushToast({ message: "找不到该章节，可能已被删除。", kind: "info" });
    return;
  }
  if (book.value.chapters.length <= 1) {
    pushToast({ message: "至少保留一章，无法删除唯一章节。", kind: "info" });
    return;
  }

  removeChapter(id);
  const actionVersion = version.value;
  pushToast({
    message: `已删除「${chapter.title}」，正文已并入相邻章节。`,
    kind: "info",
    actionLabel: "撤销",
    action: () => undoIfCurrent(actionVersion),
  });
}

function onRemoveVolume(id: string): void {
  const volume = book.value.volumes.find((item) => item.id === id);
  if (!volume) {
    pushToast({ message: "找不到该卷，可能已被删除。", kind: "info" });
    return;
  }

  removeVolume(id);
  const actionVersion = version.value;
  pushToast({
    message: `已删除卷「${volume.title}」，其下章节已提升为独立章节。`,
    kind: "info",
    actionLabel: "撤销",
    action: () => undoIfCurrent(actionVersion),
  });
}

/** 文件名清洗、截断与 Windows 保留名处理统一放在 `core/exportFileName`。 */
function exportFileName(extension: string): string {
  return buildExportFileName(book.value.meta.title, extension);
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && /[\u4e00-\u9fa5]/.test(cause.message)) {
    return `导出失败：${cause.message}`;
  }
  return "导出失败，请稍后重试。";
}

async function onExport(request: { format: string; options: ConvertOptions }): Promise<void> {
  if (exporting.value) return;
  const converter = converterRegistry[request.format];
  if (!converter) {
    pushToast({ message: "不支持的导出格式。", kind: "error" });
    return;
  }

  exporting.value = true;
  try {
    const options: ConvertOptions = {
      ...request.options,
      themeId: themeId.value,
      layout: layout.value,
    };
    const blob = await converter.convert(book.value, options);
    const filename = exportFileName(converter.extension);
    downloadBlob(blob, filename);
    pushToast({ message: `已导出「${filename}」`, kind: "success" });
  } catch (cause) {
    pushToast({ message: errorMessage(cause), kind: "error" });
  } finally {
    exporting.value = false;
  }
}
</script>

<template>
  <div class="app">
    <header class="app-header">
      <div class="brand">
        <span class="brand-mark">txt2book</span>
        <span class="brand-note">TXT 转电子书</span>
      </div>
      <div v-if="authenticated" class="header-actions">
        <a class="jump-export" href="#export-card" data-test="jump-export">跳到导出</a>
        <span class="header-user" data-test="header-user">{{ username }}</span>
        <button type="button" class="btn btn-ghost" data-test="logout" @click="onLogout">
          退出登录
        </button>
      </div>
    </header>

    <main class="app-shell">
      <h1 v-if="authenticated" class="sr-only">txt2book 工作区</h1>

      <p
        v-if="checking && !authenticated"
        class="auth-pending"
        role="status"
        data-test="auth-pending"
      >
        正在验证登录状态…
      </p>

      <LoginView v-else-if="!authenticated" />

      <div v-else class="workspace" data-test="workspace">
        <div class="workspace-col workspace-col-side" data-test="workspace-side">
          <ChapterTree
            :volumes="book.volumes"
            :chapters="book.chapters"
            :selected-id="selectedId"
            :selected-volume-id="selectedVolumeId"
            :can-undo="canUndo"
            @select="select"
            @select-volume="onSelectVolume"
            @rename="onRename"
            @remove-chapter="onRemoveChapter"
            @remove-volume="onRemoveVolume"
            @undo="undo"
          />
          <UploadPanel :session="session" :rules="rules" />
        </div>

        <div class="workspace-col workspace-col-main">
          <PreviewPane
            :chapter="selected"
            :all-chapters="book.chapters"
            :volumes="book.volumes"
            :volume="selectedVolume"
            :volume-first-chapter-id="volumeFirstChapterId"
            :theme-id="themeId"
            :layout="layout"
            :background-src="backgroundSrc"
            @select-chapter="select"
          />
        </div>

        <div class="workspace-col">
          <BookMetaPanel :meta="book.meta" @update:meta="updateMeta" />
          <CoverPanel :session="session" />
          <ThemePicker :model-value="themeId" @update:model-value="setTheme" />
          <details class="card layout-card" data-test="layout-card" open>
            <summary class="layout-card-header">
              <span class="disclosure-caret" aria-hidden="true"></span>
              <span class="layout-card-heading">
                <span class="layout-card-title">排版</span>
                <span class="layout-card-hint">
                  说明：这里的设置只影响预览和导出的电子书，不会改变应用界面。
                </span>
              </span>
            </summary>
            <div class="layout-card-body">
              <TypographyPanel
                :layout="layout"
                @update-element="onUpdateElement"
                @reset="resetTypography"
              />
              <BackgroundPanel
                :background="layout.background"
                :disabled="themeId === 'eink'"
                :busy="backgroundBusy"
                :error="backgroundError"
                :preview-src="backgroundSrc"
                @select-preset="onSelectPreset"
                @upload="onUploadBackground"
                @clear="clearBackground"
              />
            </div>
          </details>
          <CustomRulesPanel :rules="rules" @update:rules="onRulesChange" />
          <ExportPanel
            id="export-card"
            tabindex="-1"
            :converters="converters"
            :busy="exporting"
            :disabled="!hasBook"
            :hint="EXPORT_HINT"
            @export="onExport"
          />
        </div>

        <a class="btn btn-primary jump-preview" href="#preview-pane" data-test="jump-preview">
          查看预览
        </a>
      </div>
    </main>

    <ToastStack :toasts="toasts" @dismiss="dismissToast" @action="runToastAction" />
  </div>
</template>
