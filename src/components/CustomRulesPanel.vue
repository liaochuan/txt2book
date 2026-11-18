<script setup lang="ts">
import { computed, ref } from "vue";
import {
  compileRule,
  createRuleId,
  saveRules,
  type ChapterRule,
  type RuleKind,
} from "../core/customRules";

const props = defineProps<{ rules: ChapterRule[] }>();

const emit = defineEmits<{ "update:rules": [rules: ChapterRule[]] }>();

const KIND_OPTIONS: ReadonlyArray<{ value: RuleKind; label: string }> = [
  { value: "volume", label: "卷标题" },
  { value: "chapter", label: "普通章节" },
  { value: "extra", label: "番外" },
  { value: "prologue", label: "序章" },
  { value: "epilogue", label: "后记" },
];

const expanded = ref(props.rules.length > 0);
const draftOpen = ref(false);
const draftNew = ref(false);
/** 用户动过草稿后才展示校验错误，避免一打开表单就满屏红字。 */
const draftTouched = ref(false);
const draft = ref<ChapterRule>(emptyDraft());

function emptyDraft(): ChapterRule {
  return {
    id: createRuleId(),
    label: "",
    pattern: "",
    flags: "",
    capture: 0,
    enabled: true,
    kind: "chapter",
  };
}

const enabledCount = computed<number>(() => props.rules.filter((rule) => rule.enabled).length);

interface RuleValidation {
  ok: boolean;
  error: string;
}

/** 校验规则可编译性与必填字段，错误文案直接展示给用户。 */
function validateRule(rule: ChapterRule): RuleValidation {
  if (rule.label.trim() === "") return { ok: false, error: "请填写规则名称。" };
  if (rule.pattern.trim() === "") return { ok: false, error: "请填写正则表达式。" };
  if (rule.capture !== undefined && (!Number.isInteger(rule.capture) || rule.capture < 0)) {
    return { ok: false, error: "捕获组必须是不小于 0 的整数。" };
  }
  try {
    // 只校验能否编译，不在这里执行匹配。
    compileRule({ ...rule, pattern: rule.pattern.trim() });
  } catch {
    return { ok: false, error: "正则表达式无效，请检查括号、转义与 flags。" };
  }
  return { ok: true, error: "" };
}

const validation = computed<RuleValidation>(() => validateRule(draft.value));

function kindLabel(kind: RuleKind): string {
  return KIND_OPTIONS.find((option) => option.value === kind)?.label ?? "普通章节";
}

/** 所有变更都先持久化再通知父级，保证重新解析时读到同一份规则。 */
function commit(next: ChapterRule[]): void {
  saveRules(next);
  emit("update:rules", next);
}

function startAdd(): void {
  draft.value = emptyDraft();
  draftNew.value = true;
  draftTouched.value = false;
  draftOpen.value = true;
}

function startEdit(rule: ChapterRule): void {
  draft.value = { ...rule };
  draftNew.value = false;
  draftTouched.value = false;
  draftOpen.value = true;
}

function cancelDraft(): void {
  draftOpen.value = false;
}

function saveDraft(): void {
  if (!validation.value.ok) return;
  const saved: ChapterRule = {
    ...draft.value,
    label: draft.value.label.trim(),
    pattern: draft.value.pattern.trim(),
    capture: draft.value.capture ?? 0,
  };
  commit(
    draftNew.value
      ? [...props.rules, saved]
      : props.rules.map((rule) => (rule.id === saved.id ? saved : rule)),
  );
  draftOpen.value = false;
}

function toggleEnabled(id: string): void {
  commit(props.rules.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule)));
}

function removeRule(id: string): void {
  if (!window.confirm("确认删除这条规则？")) return;
  commit(props.rules.filter((rule) => rule.id !== id));
  if (draftOpen.value && !draftNew.value && draft.value.id === id) draftOpen.value = false;
}

/** number input 的事件值统一转成非负整数，避免写入 NaN。 */
function updateCapture(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  draft.value.capture = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
</script>

<template>
  <section class="card rules-panel" data-test="rules-panel">
    <header class="rules-header">
      <div class="rules-heading">
        <h2 class="rules-title">自定义章节规则</h2>
        <p class="rules-count">
          {{ rules.length }} 条 · {{ enabledCount }} 条启用
        </p>
      </div>
      <button
        type="button"
        class="btn btn-ghost"
        data-test="toggle-rules"
        :aria-expanded="expanded ? 'true' : 'false'"
        @click="expanded = !expanded"
      >
        {{ expanded ? "收起" : "展开" }}
      </button>
    </header>

    <div v-if="expanded" class="rules-body">
      <p v-if="rules.length === 0" class="rules-empty" data-test="rules-empty">
        还没有自定义规则。新增规则可补充预置规则识别不到的卷名、章节名或番外标题。
      </p>

      <ul v-else class="rules-list">
        <li
          v-for="rule in rules"
          :key="rule.id"
          class="rules-item"
          :class="{ 'rules-item-editing': draftOpen && !draftNew && draft.id === rule.id }"
          :data-test="`rule-${rule.id}`"
        >
          <label class="rules-enable">
            <input
              type="checkbox"
              data-test="rule-enabled"
              :checked="rule.enabled"
              :aria-label="`启用规则 ${rule.label}`"
              @change="toggleEnabled(rule.id)"
            />
            <span class="rules-label">{{ rule.label }}</span>
          </label>
          <span class="rules-kind">{{ kindLabel(rule.kind) }}</span>
          <code class="rules-pattern">/{{ rule.pattern }}/{{ rule.flags ?? "" }}</code>
          <div class="rules-actions">
            <button type="button" class="btn btn-ghost" data-test="rule-edit" @click="startEdit(rule)">
              编辑
            </button>
            <button
              type="button"
              class="btn btn-ghost"
              data-test="rule-remove"
              @click="removeRule(rule.id)"
            >
              删除
            </button>
          </div>
        </li>
      </ul>

      <form
        v-if="draftOpen"
        class="rules-draft"
        data-test="rule-draft"
        novalidate
        @input="draftTouched = true"
        @submit.prevent="saveDraft"
      >
        <div class="rules-draft-row">
          <div class="field">
            <label for="rule-label">名称</label>
            <input
              id="rule-label"
              v-model="draft.label"
              data-test="rule-label"
              type="text"
              placeholder="如：序章 / 番外"
              autocomplete="off"
            />
          </div>

          <div class="field">
            <label for="rule-kind">命中类型</label>
            <select id="rule-kind" v-model="draft.kind" data-test="rule-kind">
              <option v-for="option in KIND_OPTIONS" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>
          </div>
        </div>

        <div class="field">
          <label for="rule-pattern">正则表达式</label>
          <input
            id="rule-pattern"
            v-model="draft.pattern"
            data-test="rule-pattern"
            type="text"
            placeholder="如：^第[一二三四五六七八九十]+卷"
            autocomplete="off"
            spellcheck="false"
          />
        </div>

        <div class="rules-draft-row">
          <div class="field">
            <label for="rule-flags">flags</label>
            <input
              id="rule-flags"
              v-model="draft.flags"
              data-test="rule-flags"
              type="text"
              placeholder="如：i"
              autocomplete="off"
              spellcheck="false"
            />
          </div>

          <div class="field">
            <label for="rule-capture">捕获组</label>
            <input
              id="rule-capture"
              data-test="rule-capture"
              type="number"
              min="0"
              :value="draft.capture ?? 0"
              @input="updateCapture"
            />
          </div>
        </div>

        <p v-if="draftTouched && !validation.ok" class="rules-error" role="alert" data-test="rule-error">
          {{ validation.error }}
        </p>

        <div class="rules-draft-actions">
          <button type="button" class="btn btn-ghost" @click="cancelDraft">取消</button>
          <button
            type="submit"
            class="btn btn-primary"
            data-test="rule-save"
            :disabled="!validation.ok"
          >
            保存
          </button>
        </div>
      </form>

      <div v-if="!draftOpen" class="rules-footer">
        <button type="button" class="btn" data-test="add-rule" @click="startAdd">+ 新增规则</button>
      </div>
    </div>
  </section>
</template>
