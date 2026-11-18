<script setup lang="ts">
import { ref } from "vue";
import { useAuth } from "../composables/useAuth";

const emit = defineEmits<{ success: [] }>();

const auth = useAuth();
const username = ref("");
const password = ref("");
const loading = ref(false);
const localError = ref("");

async function submit(): Promise<void> {
  if (loading.value) return;
  const name = username.value.trim();
  if (name === "" || password.value === "") {
    localError.value = "请输入用户名和密码。";
    return;
  }

  localError.value = "";
  loading.value = true;
  try {
    const ok = await auth.login(name, password.value);
    if (!ok) {
      localError.value = auth.error.value || "登录失败，请检查用户名和密码。";
      return;
    }
    password.value = "";
    emit("success");
  } catch {
    localError.value = "登录失败，请稍后重试。";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="login">
    <form
      class="card login-card"
      novalidate
      :aria-busy="loading ? 'true' : 'false'"
      @submit.prevent="submit"
    >
      <header class="login-header">
        <h1 class="login-title">登录 txt2book</h1>
        <p class="login-subtitle">登录后才能抓取远程封面，生成与导出仍在本地完成。</p>
      </header>

      <div class="field">
        <label for="login-username">用户名</label>
        <input
          id="login-username"
          v-model="username"
          name="username"
          type="text"
          autocomplete="username"
          autocapitalize="none"
          spellcheck="false"
          :disabled="loading"
        />
      </div>

      <div class="field">
        <label for="login-password">密码</label>
        <input
          id="login-password"
          v-model="password"
          name="password"
          type="password"
          autocomplete="current-password"
          :aria-invalid="localError ? 'true' : undefined"
          :aria-describedby="localError ? 'login-error' : undefined"
          :disabled="loading"
        />
      </div>

      <p v-if="localError" id="login-error" class="login-error" role="alert">
        {{ localError }}
      </p>

      <button
        class="btn btn-primary login-submit"
        type="submit"
        :aria-busy="loading ? 'true' : 'false'"
        :disabled="loading"
      >
        <span v-if="loading" class="loading">登录中</span>
        <span v-else>登录</span>
      </button>
    </form>
  </div>
</template>
