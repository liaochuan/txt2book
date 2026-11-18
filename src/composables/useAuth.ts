import { ref, type Ref } from "vue";
import { ApiError, api } from "../core/api";

export interface AuthState {
  authenticated: Ref<boolean>;
  username: Ref<string>;
  /** 会话校验进行中；初次挂载时用于避免闪现登录表单。 */
  checking: Ref<boolean>;
  /** 最近一次登录失败的用户可读文案，检查会话时不会写入。 */
  error: Ref<string>;
  check(): Promise<boolean>;
  login(username: string, password: string): Promise<boolean>;
  logout(): Promise<void>;
  /** 只清空本地登录态，不访问服务端（用于会话失效回调）。 */
  clearSession(): void;
}

// 模块级单例：顶部栏与登录页共享同一份登录态。
const authenticated = ref(false);
const username = ref("");
const checking = ref(false);
const error = ref("");

function clear(): void {
  authenticated.value = false;
  username.value = "";
}

/** 登录态：`check()` 只依赖 `/api/auth/me`；仅 401 清空本地状态。 */
export function useAuth(): AuthState {
  async function check(): Promise<boolean> {
    checking.value = true;
    try {
      const session = await api.me();
      if (session.authenticated) {
        authenticated.value = true;
        username.value = session.username ?? "";
        return true;
      }
      // 服务端明确返回未登录，属于可信结论。
      clear();
      return false;
    } catch (cause) {
      // 只有 401 能证明会话失效；429、5xx、断网保留当前状态，避免误踢已登录用户。
      if (cause instanceof ApiError && cause.status === 401) clear();
      return false;
    } finally {
      checking.value = false;
    }
  }

  async function login(name: string, password: string): Promise<boolean> {
    error.value = "";
    try {
      await api.login(name, password);
    } catch (cause) {
      clear();
      error.value = cause instanceof ApiError ? cause.message : "登录失败，请稍后重试。";
      return false;
    }

    // 登录成功后回读会话，确保用户名与服务端一致；回读失败时保留乐观状态。
    authenticated.value = true;
    username.value = name;
    try {
      const session = await api.me();
      if (session.authenticated) {
        username.value = session.username ?? name;
      } else {
        clear();
        error.value = "登录状态未能保持，请重试。";
        return false;
      }
    } catch {
      // 回读失败不影响已建立的会话。
    }
    return true;
  }

  async function logout(): Promise<void> {
    try {
      await api.logout();
    } catch {
      // 登出接口失败也要清掉本地状态，避免界面停留在已登录。
    } finally {
      error.value = "";
      clear();
    }
  }

  function clearSession(): void {
    error.value = "";
    clear();
  }

  return { authenticated, username, checking, error, check, login, logout, clearSession };
}
