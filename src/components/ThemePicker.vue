<script setup lang="ts">
import { themes } from "../core/render/themes";
import type { ThemeId } from "../types/book";

const props = defineProps<{ modelValue: ThemeId }>();

const emit = defineEmits<{
  "update:modelValue": [id: ThemeId];
}>();

const options = Object.values(themes);

function select(id: ThemeId): void {
  emit("update:modelValue", id);
}

/** 卡片是 `role="radio"` 的 div，需自行实现 Enter/Space 选中。 */
function onOptionKeydown(event: KeyboardEvent, id: ThemeId): void {
  if (
    event.key === "Enter" ||
    event.key === " " ||
    event.key === "Space" ||
    event.key === "Spacebar"
  ) {
    event.preventDefault();
    select(id);
  }
}

/** 方向键在五个主题间移动并选中，与原生 radio group 行为一致。 */
function onGroupKeydown(event: KeyboardEvent): void {
  const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
  if (!keys.includes(event.key)) return;
  event.preventDefault();

  const last = options.length - 1;
  const currentIndex = Math.max(
    0,
    options.findIndex((theme) => theme.id === props.modelValue),
  );

  let nextIndex = currentIndex;
  switch (event.key) {
    case "ArrowRight":
    case "ArrowDown":
      nextIndex = currentIndex >= last ? 0 : currentIndex + 1;
      break;
    case "ArrowLeft":
    case "ArrowUp":
      nextIndex = currentIndex <= 0 ? last : currentIndex - 1;
      break;
    case "Home":
      nextIndex = 0;
      break;
    case "End":
      nextIndex = last;
      break;
  }

  const next = options[nextIndex];
  if (!next) return;
  select(next.id);

  const group = event.currentTarget;
  if (group instanceof HTMLElement) {
    group.querySelectorAll<HTMLElement>('[role="radio"]')[nextIndex]?.focus();
  }
}
</script>

<template>
  <section class="card theme-picker" data-test="theme-picker">
    <header class="theme-picker-header">
      <h2 class="theme-picker-title">排版主题</h2>
      <p class="theme-picker-hint">主题同时作用于预览与导出的电子书。</p>
    </header>

    <div
      class="theme-options"
      role="radiogroup"
      aria-label="排版主题"
      @keydown="onGroupKeydown"
    >
      <div
        v-for="theme in options"
        :key="theme.id"
        class="theme-option"
        :class="{ 'theme-option-selected': theme.id === modelValue }"
        role="radio"
        :aria-checked="theme.id === modelValue ? 'true' : 'false'"
        :tabindex="theme.id === modelValue ? 0 : -1"
        :data-test="`theme-${theme.id}`"
        @click="select(theme.id)"
        @keydown="onOptionKeydown($event, theme.id)"
      >
        <span
          class="theme-swatch"
          :class="`theme-swatch-${theme.id}`"
          aria-hidden="true"
        >
          文
        </span>
        <span class="theme-name">{{ theme.label }}</span>
        <span class="theme-desc">{{ theme.description }}</span>
      </div>
    </div>
  </section>
</template>
