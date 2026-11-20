<script lang="ts">
/** 模块级计数器：保证同一页面里多个弹窗的标题 id 不会重复。 */
let nextDialogId = 0;

/**
 * 页面滚动锁是共享资源：同一时刻可能短暂存在两个弹窗（切换弹窗的同一帧）。
 * 用模块级计数保证第一个打开时保存原值，最后一个关闭时才恢复。
 */
let scrollLockCount = 0;
let savedBodyOverflow = "";

function acquireScrollLock(): void {
  if (typeof document === "undefined") return;
  if (scrollLockCount === 0) savedBodyOverflow = document.body.style.overflow;
  scrollLockCount += 1;
  document.body.style.overflow = "hidden";
}

function releaseScrollLock(): void {
  if (typeof document === "undefined" || scrollLockCount === 0) return;
  scrollLockCount -= 1;
  if (scrollLockCount === 0) document.body.style.overflow = savedBodyOverflow;
}
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{ open: boolean; title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();

const titleId = `app-dialog-title-${++nextDialogId}`;
const panel = ref<HTMLElement | null>(null);

/** 打开前的焦点，关闭或卸载时按原值恢复。 */
let previousFocus: HTMLElement | null = null;
/** 当前实例是否已经持有滚动锁，避免重复获取或释放。 */
let holdsScrollLock = false;

function lockBody(): void {
  if (holdsScrollLock) return;
  holdsScrollLock = true;
  acquireScrollLock();
}

function unlockBody(): void {
  if (!holdsScrollLock) return;
  holdsScrollLock = false;
  releaseScrollLock();
}

function restoreFocus(): void {
  if (previousFocus && previousFocus.isConnected) previousFocus.focus();
  previousFocus = null;
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  emit("close");
}

function onBackdropClick(event: MouseEvent): void {
  if (event.target === event.currentTarget) emit("close");
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      if (typeof document !== "undefined") {
        const active = document.activeElement;
        previousFocus = active instanceof HTMLElement ? active : null;
        document.addEventListener("keydown", onKeydown);
      }
      lockBody();
      await nextTick();
      panel.value?.focus();
      return;
    }

    if (typeof document !== "undefined") {
      document.removeEventListener("keydown", onKeydown);
    }
    unlockBody();
    restoreFocus();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (typeof document !== "undefined") {
    document.removeEventListener("keydown", onKeydown);
  }
  unlockBody();
  restoreFocus();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="dialog-backdrop"
      data-test="dialog-backdrop"
      @click="onBackdropClick"
    >
      <section
        ref="panel"
        class="dialog"
        :class="{ 'dialog-wide': wide }"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        data-test="dialog"
      >
        <header class="dialog-header">
          <h2 :id="titleId" class="dialog-title">{{ title }}</h2>
          <button
            type="button"
            class="dialog-close"
            aria-label="关闭"
            data-test="dialog-close"
            @click="emit('close')"
          >
            ×
          </button>
        </header>
        <div class="dialog-body">
          <slot />
        </div>
      </section>
    </div>
  </Teleport>
</template>
