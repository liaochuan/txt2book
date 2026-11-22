<script setup lang="ts">
import { computed } from "vue";
import type {
  ElementKey,
  ElementStyle,
  FontChoice,
  LayoutSettings,
} from "../core/render/layout";

const props = defineProps<{ layout: LayoutSettings }>();

const emit = defineEmits<{
  "update-element": [payload: { key: ElementKey; patch: Partial<ElementStyle> }];
  reset: [];
}>();

interface ElementGroup {
  key: ElementKey;
  label: string;
  hint: string;
}

/** 元素顺序与 `layout.ts` 的生成顺序一致，便于对照导出的 CSS。 */
const ELEMENT_GROUPS: ElementGroup[] = [
  { key: "chapterTitle", label: "章标题", hint: "每章开头的标题。" },
  { key: "body", label: "正文", hint: "章节正文段落。" },
  { key: "volumeTitle", label: "卷标题", hint: "卷扉页标题，以及章首的卷标题。" },
  { key: "volumeNote", label: "卷首文字", hint: "卷标题与第一章之间的文字，默认居中。" },
  { key: "intro", label: "简介", hint: "简介页正文。" },
  { key: "tocTitle", label: "目录标题", hint: "目录页顶部的「目录」二字。" },
  { key: "tocItem", label: "目录条目", hint: "目录页中的章节列表。" },
];

const FONT_OPTIONS: Array<{ value: FontChoice; label: string }> = [
  { value: "song", label: "宋体" },
  { value: "hei", label: "黑体" },
  { value: "kai", label: "楷体" },
  { value: "serif", label: "衬线" },
  { value: "sans", label: "无衬线" },
];

const ALIGN_OPTIONS: Array<{ value: ElementStyle["align"]; label: string }> = [
  { value: "left", label: "左对齐" },
  { value: "center", label: "居中" },
  { value: "right", label: "右对齐" },
  { value: "justify", label: "两端对齐" },
];

type NumberField =
  | "fontSize"
  | "lineHeight"
  | "paragraphSpacing"
  | "textIndent"
  | "marginTop"
  | "marginBottom";

interface NumberControl {
  field: NumberField;
  label: string;
  min: number;
  max: number;
  step: number;
}

/** min/max/step 与 `normalizeLayout` 的裁剪范围保持一致。 */
const NUMBER_CONTROLS: NumberControl[] = [
  { field: "fontSize", label: "字号（em）", min: 0.8, max: 1.8, step: 0.05 },
  { field: "lineHeight", label: "行高", min: 1.2, max: 2.6, step: 0.05 },
  { field: "paragraphSpacing", label: "段距（em）", min: 0, max: 2, step: 0.05 },
  { field: "textIndent", label: "首行缩进（em）", min: 0, max: 4, step: 0.05 },
  { field: "marginTop", label: "上留白（em）", min: 0, max: 4, step: 0.05 },
  { field: "marginBottom", label: "下留白（em）", min: 0, max: 4, step: 0.05 },
];

const PARAGRAPH_ELEMENTS = new Set<ElementKey>(["body", "intro"]);

/** 正文与简介用「段距」控制段落间隔，其余元素用「下留白」；只渲染实际生效的字段。 */
function numberControlsFor(key: ElementKey): NumberControl[] {
  const isParagraph = PARAGRAPH_ELEMENTS.has(key);
  return NUMBER_CONTROLS.filter((control) => {
    if (control.field === "paragraphSpacing") return isParagraph;
    if (control.field === "marginBottom") return !isParagraph;
    return true;
  });
}

const groups = computed(() =>
  ELEMENT_GROUPS.map((group) => ({
    ...group,
    style: props.layout.typography.elements[group.key],
    controls: numberControlsFor(group.key),
  })),
);

function update(key: ElementKey, patch: Partial<ElementStyle>): void {
  emit("update-element", { key, patch });
}

/**
 * 清空输入框时浏览器可能给出 `""`，此时恢复为当前值；
 * 越界值先按控件范围裁剪并写回输入框，保证显示值与实际排版一致。
 */
function onNumber(
  key: ElementKey,
  field: NumberField,
  control: NumberControl,
  event: Event,
): void {
  const target = event.target as HTMLInputElement;
  const current = props.layout.typography.elements[key][field];
  const raw = target.value.trim();
  const parsed = Number(raw);
  if (raw === "" || !Number.isFinite(parsed)) {
    target.value = String(current);
    return;
  }
  const clamped = Math.min(control.max, Math.max(control.min, parsed));
  target.value = String(clamped);
  update(key, { [field]: clamped } as Partial<ElementStyle>);
}

function onFontFamily(key: ElementKey, event: Event): void {
  const value = (event.target as HTMLSelectElement).value as FontChoice;
  update(key, { fontFamily: value });
}

function onAlign(key: ElementKey, event: Event): void {
  const value = (event.target as HTMLSelectElement).value as ElementStyle["align"];
  update(key, { align: value });
}

function onColor(key: ElementKey, event: Event): void {
  const value = (event.target as HTMLInputElement).value;
  if (!/^#[0-9a-f]{6}$/i.test(value)) return;
  update(key, { color: value.toLowerCase() });
}

function onReset(): void {
  emit("reset");
}
</script>

<template>
  <section class="typography-panel" data-test="typography-panel">
    <details class="panel-details" data-test="typography-details">
      <summary class="panel-summary">
        <span class="disclosure-caret" aria-hidden="true"></span>
        <span class="panel-summary-heading">
          <span class="panel-summary-title">高级排版</span>
          <span class="panel-summary-hint">按元素调整字体、间距与配色，修改后失焦或回车生效。</span>
        </span>
      </summary>

      <div class="panel-details-body">
        <p class="panel-note">
          正文与简介用「段距」控制段落间隔，其它元素用「下留白」；两个字段按元素类型显示。
        </p>
        <details
          v-for="group in groups"
          :key="group.key"
          class="type-group"
          :data-test="`type-group-${group.key}`"
        >
          <summary class="type-group-summary">
            <span class="disclosure-caret" aria-hidden="true"></span>
            <span class="type-group-label">{{ group.label }}</span>
            <span class="type-group-hint">{{ group.hint }}</span>
          </summary>

          <div class="type-group-body">
            <div class="control-row">
              <label class="control-label" :for="`type-fontFamily-${group.key}`">字体</label>
              <select
                :id="`type-fontFamily-${group.key}`"
                class="control-input"
                :data-test="`type-fontFamily-${group.key}`"
                :value="group.style.fontFamily"
                @change="onFontFamily(group.key, $event)"
              >
                <option v-for="option in FONT_OPTIONS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>

            <div
              v-for="control in group.controls"
              :key="control.field"
              class="control-row"
            >
              <label class="control-label" :for="`type-${control.field}-${group.key}`">
                {{ control.label }}
              </label>
              <input
                :id="`type-${control.field}-${group.key}`"
                class="control-input"
                :data-test="`type-${control.field}-${group.key}`"
                type="number"
                inputmode="decimal"
                :min="control.min"
                :max="control.max"
                :step="control.step"
                :value="group.style[control.field]"
                @change="onNumber(group.key, control.field, control, $event)"
              />
            </div>

            <div class="control-row">
              <label class="control-label" :for="`type-align-${group.key}`">对齐</label>
              <select
                :id="`type-align-${group.key}`"
                class="control-input"
                :data-test="`type-align-${group.key}`"
                :value="group.style.align"
                @change="onAlign(group.key, $event)"
              >
                <option v-for="option in ALIGN_OPTIONS" :key="option.value" :value="option.value">
                  {{ option.label }}
                </option>
              </select>
            </div>

            <div class="control-row">
              <label class="control-label" :for="`type-color-${group.key}`">颜色</label>
              <input
                :id="`type-color-${group.key}`"
                class="control-input control-color"
                :data-test="`type-color-${group.key}`"
                type="color"
                :value="group.style.color"
                @input="onColor(group.key, $event)"
              />
            </div>
          </div>
        </details>

        <div class="panel-actions">
          <button
            type="button"
            class="btn btn-ghost"
            data-test="typography-reset"
            @click="onReset"
          >
            恢复当前主题默认排版
          </button>
        </div>
      </div>
    </details>
  </section>
</template>
