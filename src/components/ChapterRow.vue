<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import type { Chapter } from "../types/book";

const props = withDefaults(
  defineProps<{ chapter: Chapter; selected: boolean; canDelete?: boolean }>(),
  { canDelete: true },
);

const emit = defineEmits<{
  select: [id: string];
  rename: [payload: { id: string; title: string }];
  remove: [id: string];
}>();

const editing = ref(false);
const draft = ref("");
const input = ref<HTMLInputElement | null>(null);
/** 保存/取消只应生效一次，避免 Esc 之后的 blur 再次提交。 */
let finished = false;

const wordCount = computed<number>(() => props.chapter.lines.join("").length);

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
</script>

<template>
  <li
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
      v-if="!editing"
      type="button"
      class="btn btn-ghost chapter-rename-button"
      data-test="rename-chapter"
      :aria-label="`重命名章节 ${chapter.title}`"
      @click="startEdit"
    >
      重命名
    </button>

    <button
      type="button"
      class="btn btn-ghost chapter-delete"
      data-test="delete-chapter"
      :disabled="!canDelete"
      :title="canDelete ? undefined : '全书至少保留一章'"
      :aria-label="`删除章节 ${chapter.title}`"
      @mousedown.prevent="cancel"
      @click="emit('remove', chapter.id)"
    >
      删除
    </button>
  </li>
</template>
