<script setup lang="ts">
import type { CalibreBook } from "../types/calibre";

defineProps<{
  book: CalibreBook;
  linked: boolean;
  importing?: boolean;
  disabled?: boolean;
}>();
const emit = defineEmits<{ import: [book: CalibreBook] }>();
</script>

<template>
  <li class="calibre-row" data-test="calibre-row">
    <div class="calibre-row-main">
      <p class="calibre-row-title" data-test="calibre-row-title">{{ book.title }}</p>
      <p class="calibre-row-author" data-test="calibre-row-author">
        {{ book.authors.length > 0 ? book.authors.join("、") : "未知作者" }}
      </p>
      <ul class="calibre-badges">
        <li
          v-for="format in book.formats"
          :key="format"
          class="calibre-badge"
          data-test="calibre-format"
        >
          {{ format.toUpperCase() }}
        </li>
      </ul>
      <span v-if="linked" class="calibre-linked" data-test="calibre-linked">已关联</span>
      <span
        v-if="!book.formats.includes('TXT')"
        class="calibre-no-txt"
        data-test="calibre-no-txt"
      >
        无 TXT
      </span>
    </div>
    <button
      type="button"
      class="btn"
      data-test="calibre-import"
      :disabled="!book.formats.includes('TXT') || importing || disabled"
      @click="emit('import', book)"
    >
      {{ importing ? "导入中…" : "导入" }}
    </button>
  </li>
</template>
