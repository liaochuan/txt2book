<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { UseCalibre } from "../composables/useCalibre";
import type { CalibreBook } from "../types/calibre";
import AppDialog from "./AppDialog.vue";
import CalibreBookRow from "./CalibreBookRow.vue";

const props = defineProps<{ calibre: UseCalibre }>();
const emit = defineEmits<{
  close: [];
  "open-settings": [];
  imported: [book: CalibreBook];
}>();

const SEARCH_DELAY_MS = 300;

const info = computed(() => props.calibre.info.value);
const books = computed(() => props.calibre.books.value);
const txtOnly = computed(() => props.calibre.txtOnly.value);
const loading = computed(() => props.calibre.loading.value);
const error = computed(() => props.calibre.error.value);
const notice = computed(() => props.calibre.notice.value);
const nextOffset = computed(() => props.calibre.nextOffset.value);
const linkedBook = computed(() => props.calibre.linkedBook.value);
const canPush = computed(() => props.calibre.canPush.value);

const connected = computed(() => info.value?.connected === true);

/** 关联书籍是否属于当前连接的实例；未连接时不提示实例差异。 */
const fromOtherInstance = computed<boolean>(() => {
  const source = linkedBook.value;
  const current = info.value;
  if (!source || !current?.connected || !current.baseUrl) return false;
  try {
    return new URL(current.baseUrl).origin !== source.origin;
  } catch {
    return true;
  }
});

const search = ref(props.calibre.query.value);
const importingId = ref<number | null>(null);
/** 每次打开弹窗只做一次初始刷新；连接晚到时在变为已连接后补一次。 */
let refreshedOnOpen = false;

function refreshOnce(): void {
  if (refreshedOnOpen || !connected.value) return;
  refreshedOnOpen = true;
  void props.calibre.refresh();
}

onMounted(refreshOnce);
watch(connected, (value) => {
  if (value) refreshOnce();
});

let searchTimer: ReturnType<typeof setTimeout> | undefined;

function onSearchInput(): void {
  if (searchTimer !== undefined) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = undefined;
    props.calibre.query.value = search.value;
    void props.calibre.refresh();
  }, SEARCH_DELAY_MS);
}

onBeforeUnmount(() => {
  if (searchTimer !== undefined) clearTimeout(searchTimer);
});

function onTxtOnlyChange(event: Event): void {
  props.calibre.txtOnly.value = (event.target as HTMLInputElement).checked;
  void props.calibre.refresh();
}

function loadMore(): void {
  void props.calibre.loadMore();
}

function isLinked(book: CalibreBook): boolean {
  return !fromOtherInstance.value && linkedBook.value?.bookId === book.id;
}

async function onImport(book: CalibreBook): Promise<void> {
  if (importingId.value !== null) return;
  importingId.value = book.id;
  try {
    const imported = await props.calibre.importBook(book);
    if (imported) {
      emit("imported", book);
      emit("close");
    }
  } finally {
    importingId.value = null;
  }
}
</script>

<template>
  <AppDialog :open="true" title="Calibre-Web 书库" wide @close="emit('close')">
    <div class="calibre-library" :aria-busy="loading ? 'true' : 'false'">
      <p v-if="error" class="calibre-error" role="alert" data-test="calibre-error">
        {{ error }}
      </p>
      <p v-if="notice" class="calibre-notice" role="status" data-test="calibre-notice">
        {{ notice }}
      </p>

      <template v-if="!connected">
        <p class="calibre-empty" data-test="calibre-not-connected">
          请先在设置中连接 Calibre-Web
        </p>
        <div class="calibre-actions">
          <button
            type="button"
            class="btn btn-primary"
            data-test="calibre-go-settings"
            @click="emit('open-settings')"
          >
            前往设置
          </button>
        </div>
      </template>

      <template v-else>
        <div class="calibre-toolbar">
          <div class="field calibre-search">
            <label for="calibre-search">搜索书库</label>
            <input
              id="calibre-search"
              v-model="search"
              data-test="calibre-search"
              type="search"
              placeholder="书名或作者"
              autocomplete="off"
              @input="onSearchInput"
            />
          </div>
          <label class="calibre-check">
            <input
              type="checkbox"
              data-test="calibre-txt-only"
              :checked="txtOnly"
              @change="onTxtOnlyChange"
            />
            只看有 TXT 的
          </label>
        </div>

        <p v-if="loading" class="loading" role="status" data-test="calibre-loading">
          正在加载书库…
        </p>

        <ul v-if="books.length > 0" class="calibre-list">
          <CalibreBookRow
            v-for="book in books"
            :key="book.id"
            :book="book"
            :linked="isLinked(book)"
            :importing="importingId === book.id"
            :disabled="importingId !== null && importingId !== book.id"
            @import="onImport"
          />
        </ul>
        <p v-else-if="!loading && !error" class="calibre-empty" data-test="calibre-empty">
          书库中没有可显示的书籍。
        </p>

        <button
          v-if="nextOffset !== null"
          type="button"
          class="btn calibre-load-more"
          data-test="calibre-load-more"
          :disabled="loading"
          @click="loadMore"
        >
          加载更多
        </button>
      </template>

      <div v-if="linkedBook" class="calibre-linked-note">
        <p class="calibre-linked-book" data-test="calibre-linked-book">
          已关联：《{{ linkedBook.title }}》
        </p>
        <p v-if="fromOtherInstance" class="option-hint" data-test="calibre-other-instance">
          当前书籍来自另一个 Calibre-Web 实例
        </p>
        <p v-else-if="canPush" class="option-hint" data-test="calibre-push-hint">
          导出 EPUB 后可推送回当前 Calibre-Web 实例。
        </p>
      </div>
    </div>
  </AppDialog>
</template>
