import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginView from "../src/components/LoginView.vue";
import ToastStack from "../src/components/ToastStack.vue";
import type { Toast } from "../src/types/toast";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("LoginView", () => {
  it("uses the correct autocomplete hints and disables native validation", () => {
    const wrapper = mount(LoginView);
    const username = wrapper.get('input[name="username"]');
    const password = wrapper.get('input[name="password"]');

    expect(username.attributes("autocomplete")).toBe("username");
    expect(password.attributes("autocomplete")).toBe("current-password");
    expect(password.attributes("type")).toBe("password");
    expect(wrapper.get("form").attributes("novalidate")).toBeDefined();
  });

  it("submits through the form and emits success", async () => {
    const fetchMock = vi.fn(async (input: string) =>
      input === "/api/auth/login"
        ? new Response(null, { status: 204 })
        : jsonResponse({ authenticated: true, username: "admin" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(LoginView);

    await wrapper.get('input[name="username"]').setValue("admin");
    await wrapper.get('input[name="password"]').setValue("pw");
    await wrapper.get("form").trigger("submit");

    await vi.waitFor(() => expect(wrapper.emitted("success")).toHaveLength(1));
    expect(wrapper.get("button[type='submit']").text()).toContain("登录");
  });

  it("shows an error when the fields are empty", async () => {
    const wrapper = mount(LoginView);

    await wrapper.get("form").trigger("submit");

    expect(wrapper.get("[role='alert']").text()).toBe("请输入用户名和密码。");
  });
  it("shows the server error on 401 and clears it on the next submit", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async (_input: string) => {
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse(
          { error: { code: "UNAUTHORIZED", message: "用户名或密码错误" } },
          401,
        );
      }
      if (attempt === 2) return new Response(null, { status: 204 });
      return jsonResponse({ authenticated: true, username: "admin" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(LoginView);

    await wrapper.get('input[name="username"]').setValue("admin");
    await wrapper.get('input[name="password"]').setValue("bad");
    await wrapper.get("form").trigger("submit");

    await vi.waitFor(() =>
      expect(wrapper.get("[role='alert']").text()).toBe("用户名或密码错误"),
    );
    const password = wrapper.get('input[name="password"]');
    expect(password.attributes("aria-invalid")).toBe("true");
    expect(password.attributes("aria-describedby")).toBe("login-error");

    await wrapper.get("form").trigger("submit");

    await vi.waitFor(() => expect(wrapper.emitted("success")).toHaveLength(1));
    expect(wrapper.find("[role='alert']").exists()).toBe(false);
  });

  it("disables the form while submitting and ignores duplicate submits", async () => {
    let release: (response: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async (input: string) =>
      input === "/api/auth/login"
        ? gate
        : jsonResponse({ authenticated: true, username: "admin" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(LoginView);

    await wrapper.get('input[name="username"]').setValue("admin");
    await wrapper.get('input[name="password"]').setValue("pw");
    await wrapper.get("form").trigger("submit");
    await wrapper.vm.$nextTick();

    expect(wrapper.get('input[name="username"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('input[name="password"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get("button[type='submit']").attributes("disabled")).toBeDefined();
    expect(wrapper.get("form").attributes("aria-busy")).toBe("true");
    expect(wrapper.get("button[type='submit']").text()).toContain("登录中");

    await wrapper.get("form").trigger("submit");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(new Response(null, { status: 204 }));
    await vi.waitFor(() => expect(wrapper.emitted("success")).toHaveLength(1));
  });
});

describe("ToastStack", () => {
  const toasts: Toast[] = [
    { id: "t1", message: "已保存", kind: "success" },
    { id: "t2", message: "封面抓取失败", kind: "error", actionLabel: "知道了" },
  ];

  it("renders messages with kind classes", () => {
    const wrapper = mount(ToastStack, { props: { toasts } });

    expect(wrapper.findAll(".toast")).toHaveLength(2);
    expect(wrapper.get(".toast-success").text()).toContain("已保存");
    expect(wrapper.get(".toast-error").text()).toContain("封面抓取失败");
    expect(wrapper.get(".toast-error").attributes("role")).toBe("alert");
    expect(wrapper.get(".toast-success").attributes("role")).toBeUndefined();
  });

  it("emits action for the action button and dismiss for the close button", async () => {
    const wrapper = mount(ToastStack, { props: { toasts } });

    await wrapper.get(".toast-error .toast-action").trigger("click");
    expect(wrapper.emitted("action")).toEqual([["t2"]]);
    expect(wrapper.emitted("dismiss")).toBeUndefined();

    await wrapper.get(".toast-success .toast-close").trigger("click");
    expect(wrapper.emitted("dismiss")).toEqual([["t1"]]);
  });
});
