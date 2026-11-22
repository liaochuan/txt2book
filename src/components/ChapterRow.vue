<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { Chapter } from "../types/book";

const props = withDefaults(
  defineProps<{ chapter: Chapter; selected: boolean; canDelete?: boolean }>(),
  { canDelete: true },
);

const emit = defineEmits<{
  select: [id: string];
  rename: [payload: { id: string; title: string }];
  split: [id: string];
  remove: [id: string];
}>();

const editing = ref(false);
const draft = ref("");
const input = ref<HTMLInputElement | null>(null);
const row = ref<HTMLElement | null>(null);
const menuButton = ref<HTMLButtonElement | null>(null);
const menuOpen = ref(false);
const menuStyle = ref<Record<string, string>>({});
/** 保存/取消只应生效一次，避免 Esc 之后的 blur 再次提交。 */
let finished = false;

const wordCount = computed<number>(() => props.chapter.lines.join("").length);
const menuId = computed<string>(() => `chapter-menu-${props.chapter.id}`);

async function startEdit(): Promise<void> {
  finished = false;
  editing.value = true;
  draft.value = props.chapter.title;
  await nextTick();
  input.value?.focus();
  input.value?.select();
}

function save(): void {
  if (!editing.value || finished) return;
  finished = true;
  editing.value = false;
  const title = draft.value.trim();
  if (title && title !== props.chapter.title) emit("rename", { id: props.chapter.id, title });
}

function cancel(): void {
  finished = true;
  editing.value = false;
  draft.value = props.chapter.title;
}

/** 输入法组合期间的回车仅用于上屏，不能当作保存；Esc 同理不能取消编辑。 */
function onEnter(event: KeyboardEvent): void {
  if (event.isComposing) return;
  save();
}

function onEscape(event: KeyboardEvent): void {
  if (event.isComposing) return;
  cancel();
}

/** F2 是桌面端重命名惯例；Enter/Space 仍交给按钮原生行为触发选中。 */
function onTitleKeydown(event: KeyboardEvent): void {
  if (event.key !== "F2") return;
  event.preventDefault();
  void startEdit();
}

/** 菜单位于目录滚动列内部，用 fixed 定位避免被列的 overflow 裁掉。 */
function updateMenuPosition(): void {
  if (typeof window === "undefined") return;
  const rect = menuButton.value?.getBoundingClientRect();
  if (!rect) return;

  const style: Record<string, string> = {
    right: `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`,
  };
  const spaceBelow = window.innerHeight - rect.bottom;
  if (spaceBelow < 160 && rect.top > 160) {
    style.bottom = `${Math.round(window.innerHeight - rect.top + 2)}px`;
  } else {
    style.top = `${Math.round(rect.bottom + 2)}px`;
  }
  menuStyle.value = style;
}

function closeMenu(restoreFocus = false): void {
  menuOpen.value = false;
  if (restoreFocus) menuButton.value?.focus();
}

function toggleMenu(): void {
  if (menuOpen.value) {
    closeMenu();
    return;
  }
  updateMenuPosition();
  menuOpen.value = true;
}

/**
 * 点击行外关闭菜单；菜单项都在行内，因此不会被这里提前关掉。
 * Escape 关闭后把焦点还给触发按钮，键盘用户不会掉到页面顶部。
 */
function onDocumentPointer(event: MouseEvent): void {
  if (!menuOpen.value) return;
  const target = event.target;
  if (target instanceof Node && row.value?.contains(target)) return;
  closeMenu();
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || !menuOpen.value) return;
  closeMenu(true);
}

/** 键盘打开另一行菜单时，关闭当前行，保证同一时间只有一个菜单。 */
function onOtherMenuOpen(event: Event): void {
  const detail = (event as CustomEvent<string>).detail;
  if (detail !== menuId.value) closeMenu();
}

/** 滚动或窗口尺寸变化后 fixed 坐标会失效，直接关闭最稳妥。 */
function onViewportChange(): void {
  closeMenu();
}

watch(menuOpen, (open) => {
  if (typeof document === "undefined") return;
  if (open) {
    document.addEventListener("mousedown", onDocumentPointer);
    document.addEventListener("keydown", onDocumentKeydown);
    document.addEventListener("chapter-menu:open", onOtherMenuOpen);
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    document.dispatchEvent(
      new CustomEvent<string>("chapter-menu:open", { detail: menuId.value }),
    );
    return;
  }
  document.removeEventListener("mousedown", onDocumentPointer);
  document.removeEventListener("keydown", onDocumentKeydown);
  document.removeEventListener("chapter-menu:open", onOtherMenuOpen);
  window.removeEventListener("resize", onViewportChange);
  window.removeEventListener("scroll", onViewportChange, true);
});

onBeforeUnmount(() => {
  if (typeof document === "undefined") return;
  document.removeEventListener("mousedown", onDocumentPointer);
  document.removeEventListener("keydown", onDocumentKeydown);
  document.removeEventListener("chapter-menu:open", onOtherMenuOpen);
  window.removeEventListener("resize", onViewportChange);
  window.removeEventListener("scroll", onViewportChange, true);
});

function onRename(): void {
  closeMenu();
  void startEdit();
}

function onSplit(): void {
  // 先把焦点交还触发按钮，AppDialog 关闭后才能回到这里。
  menuButton.value?.focus();
  closeMenu();
  emit("split", props.chapter.id);
}

function onRemove(): void {
  closeMenu();
  cancel();
  emit("remove", props.chapter.id);
}
</script>

<template>
  <li
    ref="row"
    class="chapter-row"
    :class="{ 'chapter-row-selected': selected }"
    data-test="chapter-row"
    :data-chapter-id="chapter.id"
  >
    <input
      v-if="editing"
      ref="input"
      v-model="draft"
      class="chapter-rename"
      data-test="rename-input"
      type="text"
      aria-label="章节标题"
      @keydown.enter.prevent="onEnter"
      @keydown.esc.prevent="onEscape"
      @blur="save"
    />
    <button
      v-else
      type="button"
      class="chapter-title"
      :title="chapter.title"
      :aria-current="selected ? 'true' : undefined"
      @click="emit('select', chapter.id)"
      @dblclick="startEdit"
      @keydown="onTitleKeydown"
    >
      {{ chapter.title }}
    </button>

    <span class="chapter-words" :title="`${wordCount} 字`">{{ wordCount }} 字</span>

    <button
      ref="menuButton"
      type="button"
      class="btn btn-ghost chapter-menu-button"
      data-test="chapter-menu"
      :aria-expanded="menuOpen ? 'true' : 'false'"
      :aria-controls="menuOpen ? menuId : undefined"
      :aria-label="`更多操作 ${chapter.title}`"
      @mousedown.prevent
      @click="toggleMenu"
    >
      <span aria-hidden="true">⋯</span>
    </button>

    <div
      v-if="menuOpen"
      :id="menuId"
      class="chapter-menu"
      role="group"
      aria-label="章节操作"
      data-test="chapter-menu-panel"
      :style="menuStyle"
    >
      <button
        type="button"
        class="chapter-menu-item"
        data-test="rename-chapter"
        :aria-label="`重命名章节 ${chapter.title}`"
        @click="onRename"
      >
        重命名
      </button>
      <button
        type="button"
        class="chapter-menu-item"
        data-test="split-chapter"
        :disabled="chapter.lines.length < 2"
        :title="chapter.lines.length < 2 ? '正文不足，无法分章' : '从正文中选一行拆成新章节'"
        :aria-label="`分章 ${chapter.title}`"
        @click="onSplit"
      >
        分章
      </button>
      <button
        type="button"
        class="chapter-menu-item chapter-menu-danger"
        data-test="delete-chapter"
        :disabled="!canDelete"
        :title="canDelete ? undefined : '全书至少保留一章'"
        :aria-label="`删除章节 ${chapter.title}`"
        @mousedown.prevent="cancel"
        @click="onRemove"
      >
        删除
      </button>
    </div>
  </li>
</template>
