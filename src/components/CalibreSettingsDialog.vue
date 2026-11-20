<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { UseCalibre } from "../composables/useCalibre";
import AppDialog from "./AppDialog.vue";

const props = defineProps<{ calibre: UseCalibre }>();
const emit = defineEmits<{ close: []; "open-library": [] }>();

const DISCONNECT_CONFIRM = "断开连接后将无法继续浏览 Calibre-Web 书库，确定断开吗？";
const FORGET_CONFIRM = "忘记凭据后下次需要重新输入密码，确定继续吗？";

const info = computed(() => props.calibre.info.value);
const connecting = computed(() => props.calibre.connecting.value);
const error = computed(() => props.calibre.error.value);
const notice = computed(() => props.calibre.notice.value);

const connected = computed(() => info.value?.connected === true);
const saved = computed(() => info.value?.saved === true);
/** 已保存连接正在自动恢复：只在连接尝试确实进行中时显示“正在恢复”。 */
const resuming = computed(() => !connected.value && saved.value && connecting.value);
const busy = computed(() => connecting.value);

const baseUrl = ref(info.value?.baseUrl ?? "");
const username = ref(info.value?.username ?? "");
const password = ref("");
const showForm = ref(false);

// 已保存的连接由服务端异步返回；仅在表单仍为空时预填，避免覆盖用户输入。
watch(info, (value) => {
  if (showForm.value || !value || value.connected) return;
  if (baseUrl.value !== "" || username.value !== "") return;
  baseUrl.value = value.baseUrl ?? "";
  username.value = value.username ?? "";
  password.value = "";
});

async function submit(): Promise<void> {
  if (connecting.value) return;
  const ok = await props.calibre.connect({
    baseUrl: baseUrl.value.trim(),
    username: username.value.trim(),
    password: password.value,
  });
  if (ok) {
    password.value = "";
    showForm.value = false;
  }
}

function openForm(): void {
  baseUrl.value = info.value?.baseUrl ?? "";
  username.value = info.value?.username ?? "";
  password.value = "";
  showForm.value = true;
}

function cancelEdit(): void {
  password.value = "";
  showForm.value = false;
}

function onDisconnect(): void {
  if (!window.confirm(DISCONNECT_CONFIRM)) return;
  void props.calibre.disconnect();
}

function onForget(): void {
  if (!window.confirm(FORGET_CONFIRM)) return;
  void props.calibre.forget();
}
</script>

<template>
  <AppDialog :open="true" title="Calibre-Web 设置" @close="emit('close')">
    <div class="calibre-settings" :aria-busy="busy ? 'true' : 'false'">
      <p v-if="!connected && saved && !resuming" class="option-hint" data-test="calibre-saved">
        已保存连接
      </p>
      <p
        v-if="resuming"
        class="option-hint"
        role="status"
        data-test="calibre-resuming"
      >
        正在恢复…
      </p>

      <p v-if="error" class="calibre-error" role="alert" data-test="calibre-error">
        {{ error }}
      </p>
      <p v-if="notice" class="calibre-notice" role="status" data-test="calibre-notice">
        {{ notice }}
      </p>

      <form v-if="!connected || showForm" class="calibre-form" @submit.prevent="submit">
        <div class="field">
          <label for="calibre-base-url">地址</label>
          <input
            id="calibre-base-url"
            v-model="baseUrl"
            data-test="calibre-base-url"
            type="url"
            inputmode="url"
            placeholder="https://calibre.example.com"
            autocomplete="off"
            :disabled="connecting"
          />
        </div>
        <div class="field">
          <label for="calibre-username">账号</label>
          <input
            id="calibre-username"
            v-model="username"
            data-test="calibre-username"
            type="text"
            autocomplete="username"
            :disabled="connecting"
          />
        </div>
        <div class="field">
          <label for="calibre-password">密码</label>
          <input
            id="calibre-password"
            v-model="password"
            data-test="calibre-password"
            type="password"
            autocomplete="off"
            :disabled="connecting"
          />
        </div>
        <div class="calibre-actions">
          <button
            type="submit"
            class="btn btn-primary"
            data-test="calibre-connect"
            :disabled="connecting"
          >
            {{ connecting ? "正在连接" : "连接" }}
          </button>
          <button
            v-if="showForm"
            type="button"
            class="btn btn-ghost"
            data-test="calibre-cancel"
            :disabled="connecting"
            @click="cancelEdit"
          >
            取消
          </button>
        </div>
      </form>

      <template v-else>
        <div class="calibre-session">
          <p class="calibre-session-line">
            <span class="calibre-session-label">地址</span>
            <span data-test="calibre-base-url">{{ info?.baseUrl || "—" }}</span>
          </p>
          <p class="calibre-session-line">
            <span class="calibre-session-label">账号</span>
            <span data-test="calibre-username">{{ info?.username || "—" }}</span>
          </p>
        </div>

        <div class="calibre-actions">
          <button
            type="button"
            class="btn btn-primary"
            data-test="calibre-open-library"
            :disabled="busy"
            @click="emit('open-library')"
          >
            打开书库
          </button>
          <button
            type="button"
            class="btn"
            data-test="calibre-edit"
            :disabled="busy"
            @click="openForm"
          >
            修改连接
          </button>
          <button
            type="button"
            class="btn"
            data-test="calibre-disconnect"
            :disabled="busy"
            @click="onDisconnect"
          >
            断开连接
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            data-test="calibre-forget"
            :disabled="busy"
            @click="onForget"
          >
            忘记凭据
          </button>
        </div>
      </template>
    </div>
  </AppDialog>
</template>
