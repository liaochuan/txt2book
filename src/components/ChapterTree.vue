<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { Chapter, Volume } from "../types/book";
import ChapterRow from "./ChapterRow.vue";

const props = defineProps<{
  volumes: Volume[];
  chapters: Chapter[];
  selectedId: string | null;
  selectedVolumeId: string | null;
  canUndo: boolean;
}>();

const emit = defineEmits<{
  select: [id: string];
  "select-volume": [id: string];
  "remove-chapter": [id: string];
  "remove-volume": [id: string];
  rename: [payload: { id: string; title: string }];
  "split-chapter": [id: string];
  undo: [];
}>();

const STORAGE_KEY = "txt2book.collapsed";
const EXTRA_GROUP_LABEL = "番外";

/** 折叠状态来自 localStorage，内容不可信：只接受字符串数组，其余一律当作空。 */
function readCollapsed(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

const collapsedIds = ref<string[]>(readCollapsed());
const query = ref("");
const treeRoot = ref<HTMLElement | null>(null);
/** 最近一次定位的章节；短暂高亮，便于在长目录中确认位置。 */
const locatedId = ref<string | null>(null);
let locateTimer: ReturnType<typeof setTimeout> | null = null;

function persistCollapsed(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsedIds.value));
  } catch {
    // 隐私模式等场景下写入失败不影响交互，本次会话内仍保持折叠。
  }
}

/** 搜索词归一化：去掉所有空白（含全角空格）并忽略大小写，避免用户复制标题时带空格。 */
function normalize(value: string): string {
  return value.replace(/[\s\u3000]+/g, "").toLowerCase();
}

const keyword = computed<string>(() => normalize(query.value));
const searching = computed<boolean>(() => keyword.value !== "");

function isCollapsed(volumeId: string): boolean {
  // 搜索时强制展开，避免命中的章节藏在折叠的卷里。
  if (searching.value) return false;
  return collapsedIds.value.includes(volumeId);
}

function toggle(volumeId: string): void {
  // 搜索态下折叠开关被禁用，这里再兜一层，防止程序化触发改变用户持久化的意图。
  if (searching.value) return;

  collapsedIds.value = collapsedIds.value.includes(volumeId)
    ? collapsedIds.value.filter((item) => item !== volumeId)
    : [...collapsedIds.value, volumeId];

  persistCollapsed();
}

const totalCount = computed<number>(() => props.chapters.length);

/** 全书仅剩一章时禁止删除，避免唯一目录项与正文一起消失。 */
const canDeleteChapter = computed<boolean>(() => props.chapters.length > 1);

const matchedChapters = computed<Chapter[]>(() => {
  const key = keyword.value;
  if (!key) return props.chapters;
  return props.chapters.filter((chapter) => normalize(chapter.title).includes(key));
});

const volumeMap = computed<Map<string, Volume>>(
  () => new Map(props.volumes.map((volume) => [volume.id, volume])),
);

interface TreeGroup {
  /** 同一卷可能因根级章节打断而分成多组，key 带上序号避免重复。 */
  key: string;
  /** 根级章节组为 `null`。 */
  volume: Volume | null;
  label: string;
  subtitle: string;
  chapters: Chapter[];
}

/** 番外分组固定显示“番外”，原始标题作为副标题。 */
function volumeLabel(volume: Volume): string {
  return volume.kind === "extra-group" ? EXTRA_GROUP_LABEL : volume.title;
}

function volumeSubtitle(volume: Volume): string {
  if (volume.kind !== "extra-group") return "";
  return volume.title && volume.title !== EXTRA_GROUP_LABEL ? volume.title : "";
}

/**
 * 番外分组没有独立扉页，卷名按钮只负责折叠/展开，不进入卷预览。
 *
 * 卷名的 aria-label 与 `.volume-count` 统一使用「当前组内的章节数」：
 * 搜索时两者同步显示过滤后的数量，避免一个显示整卷、一个显示匹配数。
 */
function volumeName(volume: Volume, count: number): string {
  if (volume.kind === "extra-group") {
    return `${isCollapsed(volume.id) ? "展开" : "折叠"}分组 ${volumeLabel(volume)}`;
  }
  return `选中卷 ${volumeLabel(volume)}（${count} 章）`;
}

function onVolumeName(volume: Volume): void {
  if (volume.kind === "extra-group") {
    toggle(volume.id);
    return;
  }
  emit("select-volume", volume.id);
}

/**
 * 分组顺序与 `chapters` 的阅读顺序一致：遍历章节，`volumeId` 变化时开新组，
 * 根级章节同样按出现位置成组，不再强制置顶。
 * 番外分组在解析阶段已移到末尾，因此这里无需再按类型重排。
 */
const groups = computed<TreeGroup[]>(() => {
  const result: TreeGroup[] = [];
  let current: TreeGroup | null = null;

  for (const chapter of matchedChapters.value) {
    const volume =
      chapter.volumeId === null ? undefined : volumeMap.value.get(chapter.volumeId);
    const volumeId = volume?.id ?? null;
    if (current === null || (current.volume?.id ?? null) !== volumeId) {
      current = {
        key: `${volumeId ?? "root"}:${result.length}`,
        volume: volume ?? null,
        label: volume ? volumeLabel(volume) : "",
        subtitle: volume ? volumeSubtitle(volume) : "",
        chapters: [],
      };
      result.push(current);
    }
    current.chapters.push(chapter);
  }

  // 没有任何章节的卷（如只有卷首文字）保留可折叠分组，追加在末尾；
  // 搜索态下与其它空分组一样隐藏。
  if (!searching.value) {
    const grouped = new Set(
      result
        .map((group) => group.volume?.id)
        .filter((id): id is string => id !== undefined),
    );
    for (const volume of props.volumes) {
      if (grouped.has(volume.id)) continue;
      result.push({
        key: `${volume.id}:empty`,
        volume,
        label: volumeLabel(volume),
        subtitle: volumeSubtitle(volume),
        chapters: [],
      });
    }
  }

  return result;
});

const emptyTree = computed<boolean>(() => !searching.value && totalCount.value === 0);
const emptyResult = computed<boolean>(() => searching.value && matchedChapters.value.length === 0);

/** 在目录 DOM 中按 id 找到行；不用 querySelector，避免章节 id 需要 CSS 转义。 */
function findRow(id: string): HTMLElement | null {
  const rows = treeRoot.value?.querySelectorAll<HTMLElement>("[data-chapter-id]") ?? [];
  for (const row of rows) {
    if (row.dataset.chapterId === id) return row;
  }
  return null;
}

function flashLocated(id: string): void {
  if (locateTimer !== null) clearTimeout(locateTimer);
  locatedId.value = id;
  locateTimer = setTimeout(() => {
    locateTimer = null;
    locatedId.value = null;
  }, 1600);
}

/**
 * 把指定章节滚动到可见位置：
 * - 折叠的卷先展开；
 * - 搜索过滤掉了目标时清空搜索；
 * - 行渲染完成后调用 scrollIntoView，并短暂高亮。
 */
async function locate(id: string | null = props.selectedId): Promise<void> {
  if (!id) return;
  const target = props.chapters.find((chapter) => chapter.id === id);
  if (!target) return;

  if (target.volumeId !== null && collapsedIds.value.includes(target.volumeId)) {
    collapsedIds.value = collapsedIds.value.filter((item) => item !== target.volumeId);
    persistCollapsed();
  }
  if (searching.value && !matchedChapters.value.some((chapter) => chapter.id === id)) {
    query.value = "";
  }

  await nextTick();
  const row = findRow(id);
  if (!row) return;

  row.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  flashLocated(id);
}

watch(
  () => props.selectedId,
  (id) => {
    if (id) void locate(id);
  },
  { flush: "post" },
);

onBeforeUnmount(() => {
  if (locateTimer !== null) clearTimeout(locateTimer);
});

defineExpose({ locate });
</script>

<template>
  <section ref="treeRoot" class="card chapter-tree">
    <header class="tree-header">
      <div class="tree-heading">
        <h2 class="tree-title">章节目录</h2>
        <span class="tree-count" data-test="chapter-count">
          {{ searching ? `匹配 ${matchedChapters.length} / ${totalCount} 章` : `共 ${totalCount} 章` }}
        </span>
      </div>
      <button
        v-if="canUndo"
        type="button"
        class="btn btn-ghost"
        data-test="undo"
        @click="emit('undo')"
      >
        撤销
      </button>
    </header>

    <div class="field tree-search">
      <label class="field-label" for="chapter-search">搜索章节</label>
      <input
        id="chapter-search"
        v-model="query"
        data-test="search"
        type="search"
        placeholder="按标题过滤"
        autocomplete="off"
      />
    </div>

    <p v-if="emptyTree" class="tree-empty" data-test="empty-tree">
      还没有章节，导入 TXT 后会出现在这里。
    </p>

    <p v-else-if="emptyResult" class="tree-empty" data-test="empty-result">
      没有匹配「{{ query.trim() }}」的章节。
    </p>

    <template v-else>
      <template v-for="group in groups" :key="group.key">
        <ul v-if="!group.volume" class="chapter-list tree-root">
          <ChapterRow
            v-for="chapter in group.chapters"
            :key="chapter.id"
            :chapter="chapter"
            :class="{ 'chapter-row-located': chapter.id === locatedId }"
            :selected="chapter.id === selectedId"
            :can-delete="canDeleteChapter"
            @select="emit('select', $event)"
            @rename="emit('rename', $event)"
            @split="emit('split-chapter', $event)"
            @remove="emit('remove-chapter', $event)"
          />
        </ul>

        <section
          v-else
          class="tree-volume"
          data-test="volume"
          :data-volume-id="group.volume.id"
        >
          <div class="volume-header">
            <button
              type="button"
              class="volume-toggle"
              :aria-expanded="!isCollapsed(group.volume.id)"
              :aria-controls="
                isCollapsed(group.volume.id) ? undefined : `chapter-list-${group.volume.id}`
              "
              :aria-label="`${isCollapsed(group.volume.id) ? '展开' : '折叠'}卷 ${group.label}`"
              :disabled="searching"
              :title="searching ? '搜索时无法折叠分组' : undefined"
              @click="toggle(group.volume.id)"
            >
              <span class="volume-caret" aria-hidden="true">
                {{ isCollapsed(group.volume.id) ? "▸" : "▾" }}
              </span>
            </button>
            <button
              type="button"
              class="volume-name"
              :class="{
                'volume-name-selected':
                  group.volume.kind === 'volume' && group.volume.id === selectedVolumeId,
              }"
              :aria-current="
                group.volume.kind === 'volume' && group.volume.id === selectedVolumeId
                  ? 'true'
                  : undefined
              "
              :aria-expanded="
                group.volume.kind === 'extra-group'
                  ? !isCollapsed(group.volume.id)
                  : undefined
              "
              :aria-label="volumeName(group.volume, group.chapters.length)"
              :disabled="group.volume.kind === 'extra-group' && searching"
              :title="
                group.volume.kind === 'extra-group' && searching
                  ? '搜索时无法折叠分组'
                  : undefined
              "
              @click="onVolumeName(group.volume)"
            >
              <span class="volume-title">{{ group.label }}</span>
              <span v-if="group.subtitle" class="volume-subtitle">{{ group.subtitle }}</span>
              <span class="volume-count">{{ group.chapters.length }} 章</span>
            </button>
            <button
              type="button"
              class="btn btn-ghost volume-delete"
              data-test="delete-volume"
              :aria-label="`删除卷 ${group.label}`"
              @click="emit('remove-volume', group.volume.id)"
            >
              删除
            </button>
          </div>

          <ul
            v-if="!isCollapsed(group.volume.id)"
            :id="`chapter-list-${group.volume.id}`"
            class="chapter-list"
          >
            <ChapterRow
              v-for="chapter in group.chapters"
              :key="chapter.id"
              :chapter="chapter"
              :class="{ 'chapter-row-located': chapter.id === locatedId }"
              :selected="chapter.id === selectedId"
              :can-delete="canDeleteChapter"
              @select="emit('select', $event)"
              @rename="emit('rename', $event)"
              @split="emit('split-chapter', $event)"
              @remove="emit('remove-chapter', $event)"
            />
            <li v-if="group.chapters.length === 0" class="volume-empty">本卷暂无章节</li>
          </ul>
          <p v-else class="volume-collapsed">已折叠 {{ group.chapters.length }} 章</p>
        </section>
      </template>
    </template>
  </section>
</template>
