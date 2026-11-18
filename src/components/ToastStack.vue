<script setup lang="ts">
import type { Toast } from "../types/toast";

defineProps<{ toasts: Toast[] }>();
const emit = defineEmits<{ dismiss: [id: string]; action: [id: string] }>();
</script>

<template>
  <div class="toast-stack" role="status" aria-live="polite">
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="toast"
      :class="`toast-${toast.kind}`"
      :role="toast.kind === 'error' ? 'alert' : undefined"
    >
      <span class="toast-message">{{ toast.message }}</span>
      <button
        v-if="toast.actionLabel"
        type="button"
        class="btn btn-ghost toast-action"
        @click="emit('action', toast.id)"
      >
        {{ toast.actionLabel }}
      </button>
      <button
        type="button"
        class="toast-close"
        aria-label="关闭提示"
        @click="emit('dismiss', toast.id)"
      >
        ×
      </button>
    </div>
  </div>
</template>
