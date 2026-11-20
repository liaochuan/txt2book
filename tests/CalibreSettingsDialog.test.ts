import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computed, ref } from "vue";
import CalibreSettingsDialog from "../src/components/CalibreSettingsDialog.vue";
import type { UseCalibre } from "../src/composables/useCalibre";
import type { BookSource } from "../src/types/book";
import type { CalibreBook, CalibreSessionInfo } from "../src/types/calibre";

const SAVED_INFO: CalibreSessionInfo = {
  connected: false,
  saved: true,
  baseUrl: "https://calibre.example.com",
  username: "reader",
};

const CONNECTED_INFO: CalibreSessionInfo = {
  connected: true,
  saved: true,
  baseUrl: "https://calibre.example.com",
  username: "reader",
  canPush: true,
};

function createCalibre(options: { info?: CalibreSessionInfo | null; connecting?: boolean } = {}) {
  const info = ref<CalibreSessionInfo | null>(options.info ?? null);
  const books = ref<CalibreBook[]>([]);
  const query = ref("");
  const txtOnly = ref(false);
  const loading = ref(false);
  const error = ref("");
  const notice = ref("");
  const nextOffset = ref<number | null>(null);
  const connecting = ref(options.connecting ?? false);
  const pushing = ref(false);
  const linked = ref<BookSource | null>(null);
  const linkedBook = computed<BookSource | null>(() => linked.value);
  const canPush = computed<boolean>(() => options.info?.canPush ?? false);

  const calibre: UseCalibre = {
    info,
    books,
    query,
    txtOnly,
    loading,
    error,
    notice,
    nextOffset,
    connecting,
    pushing,
    linkedBook,
    canPush,
    loadStatus: vi.fn(async () => {}),
    connect: vi.fn(async () => true),
    resume: vi.fn(async () => true),
    disconnect: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    importBook: vi.fn(async () => true),
    push: vi.fn(async () => true),
    clearLocal: vi.fn(),
  };

  return {
    calibre,
    refs: { info, connecting },
  };
}

function mountDialog(calibre: UseCalibre) {
  return mount(CalibreSettingsDialog, {
    props: { calibre },
    global: { stubs: { teleport: true } },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CalibreSettingsDialog connection states", () => {
  it("renders the connection form and submits the credentials", async () => {
    const { calibre } = createCalibre();
    const wrapper = mountDialog(calibre);

    expect(wrapper.find('[data-test="calibre-base-url"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="calibre-username"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="calibre-password"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="calibre-connect"]').text()).toBe("连接");
    expect(wrapper.find('[data-test="calibre-open-library"]').exists()).toBe(false);

    await wrapper.get('[data-test="calibre-base-url"]').setValue("https://shelf.example.com");
    await wrapper.get('[data-test="calibre-username"]').setValue("reader");
    await wrapper.get('[data-test="calibre-password"]').setValue("secret");
    await wrapper.get("form").trigger("submit");

    expect(calibre.connect).toHaveBeenCalledWith({
      baseUrl: "https://shelf.example.com",
      username: "reader",
      password: "secret",
    });
  });

  it("prefills the saved address and account without exposing the password", () => {
    const { calibre } = createCalibre({ info: SAVED_INFO });
    const wrapper = mountDialog(calibre);

    expect(wrapper.get('[data-test="calibre-saved"]').text()).toBe("已保存连接");
    expect(wrapper.get('[data-test="calibre-saved"]').text()).not.toContain("正在恢复");
    expect(
      (wrapper.get('[data-test="calibre-base-url"]').element as HTMLInputElement).value,
    ).toBe(SAVED_INFO.baseUrl);
    expect(
      (wrapper.get('[data-test="calibre-username"]').element as HTMLInputElement).value,
    ).toBe(SAVED_INFO.username);
    expect(
      (wrapper.get('[data-test="calibre-password"]').element as HTMLInputElement).value,
    ).toBe("");
  });

  it("shows the resuming state only while the connection attempt is running", async () => {
    const { calibre, refs } = createCalibre({ info: SAVED_INFO });
    const wrapper = mountDialog(calibre);

    expect(wrapper.find('[data-test="calibre-resuming"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="calibre-saved"]').text()).toBe("已保存连接");

    refs.connecting.value = true;
    await wrapper.vm.$nextTick();

    expect(wrapper.get('[data-test="calibre-resuming"]').text()).toBe("正在恢复…");
    expect(wrapper.find('[data-test="calibre-saved"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="calibre-base-url"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="calibre-username"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="calibre-password"]').attributes("disabled")).toBeDefined();
    expect(wrapper.get('[data-test="calibre-connect"]').attributes("disabled")).toBeDefined();

    // F7 回归：恢复结束后必须回到“已保存连接”，不能永久显示“正在恢复”。
    refs.connecting.value = false;
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-test="calibre-resuming"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="calibre-saved"]').text()).toBe("已保存连接");
  });

  it("uses a truthful saved hint after disconnect and keeps the form usable", () => {
    const { calibre } = createCalibre({ info: SAVED_INFO });
    const wrapper = mountDialog(calibre);

    expect(wrapper.get('[data-test="calibre-saved"]').text()).toBe("已保存连接");
    expect(wrapper.text()).not.toContain("正在恢复");
    expect(wrapper.get('[data-test="calibre-base-url"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-test="calibre-username"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-test="calibre-password"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.get('[data-test="calibre-connect"]').attributes("disabled")).toBeUndefined();
  });

  it("shows the address, account and session actions when connected", () => {
    const { calibre } = createCalibre({ info: CONNECTED_INFO });
    const wrapper = mountDialog(calibre);

    expect(wrapper.get('[data-test="calibre-base-url"]').text()).toBe(CONNECTED_INFO.baseUrl);
    expect(wrapper.get('[data-test="calibre-username"]').text()).toBe(CONNECTED_INFO.username);
    expect(wrapper.get('[data-test="calibre-open-library"]').text()).toBe("打开书库");
    expect(wrapper.get('[data-test="calibre-edit"]').text()).toBe("修改连接");
    expect(wrapper.get('[data-test="calibre-disconnect"]').text()).toBe("断开连接");
    expect(wrapper.get('[data-test="calibre-forget"]').text()).toBe("忘记凭据");
    expect(wrapper.find("form").exists()).toBe(false);
  });

  it("opens the library from the connected state", async () => {
    const { calibre } = createCalibre({ info: CONNECTED_INFO });
    const wrapper = mountDialog(calibre);

    await wrapper.get('[data-test="calibre-open-library"]').trigger("click");

    expect(wrapper.emitted("open-library")).toHaveLength(1);
  });

  it("reopens the form with saved values and an empty password on edit", async () => {
    const { calibre } = createCalibre({ info: CONNECTED_INFO });
    const wrapper = mountDialog(calibre);

    await wrapper.get('[data-test="calibre-edit"]').trigger("click");

    expect(
      (wrapper.get('[data-test="calibre-base-url"]').element as HTMLInputElement).value,
    ).toBe(CONNECTED_INFO.baseUrl);
    expect(
      (wrapper.get('[data-test="calibre-username"]').element as HTMLInputElement).value,
    ).toBe(CONNECTED_INFO.username);
    expect(
      (wrapper.get('[data-test="calibre-password"]').element as HTMLInputElement).value,
    ).toBe("");
  });

  it("clears the local password after a successful connect", async () => {
    const { calibre } = createCalibre();
    const wrapper = mountDialog(calibre);

    await wrapper.get('[data-test="calibre-base-url"]').setValue("https://shelf.example.com");
    await wrapper.get('[data-test="calibre-password"]').setValue("secret");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(
      (wrapper.get('[data-test="calibre-password"]').element as HTMLInputElement).value,
    ).toBe("");
  });

  it("keeps the password when the connection fails", async () => {
    const { calibre } = createCalibre();
    vi.mocked(calibre.connect).mockResolvedValueOnce(false);
    const wrapper = mountDialog(calibre);

    await wrapper.get('[data-test="calibre-password"]').setValue("secret");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(
      (wrapper.get('[data-test="calibre-password"]').element as HTMLInputElement).value,
    ).toBe("secret");
  });

  it("shows errors and notices from the composable", async () => {
    const { calibre } = createCalibre({ info: SAVED_INFO });
    const wrapper = mountDialog(calibre);

    calibre.error.value = "账号或密码错误";
    calibre.notice.value = "已恢复连接";
    await wrapper.vm.$nextTick();

    expect(wrapper.get('[data-test="calibre-error"]').attributes("role")).toBe("alert");
    expect(wrapper.get('[data-test="calibre-error"]').text()).toBe("账号或密码错误");
    expect(wrapper.get('[data-test="calibre-notice"]').attributes("role")).toBe("status");
    expect(wrapper.get('[data-test="calibre-notice"]').text()).toBe("已恢复连接");
  });
});

describe("CalibreSettingsDialog confirmations", () => {
  it("disconnects only after confirmation", async () => {
    const { calibre } = createCalibre({ info: CONNECTED_INFO });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const wrapper = mountDialog(calibre);

    await wrapper.get('[data-test="calibre-disconnect"]').trigger("click");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calibre.disconnect).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await wrapper.get('[data-test="calibre-disconnect"]').trigger("click");
    expect(calibre.disconnect).toHaveBeenCalledTimes(1);
  });

  it("forgets credentials only after confirmation", async () => {
    const { calibre } = createCalibre({ info: CONNECTED_INFO });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const wrapper = mountDialog(calibre);

    await wrapper.get('[data-test="calibre-forget"]').trigger("click");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calibre.forget).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await wrapper.get('[data-test="calibre-forget"]').trigger("click");
    expect(calibre.forget).toHaveBeenCalledTimes(1);
  });
});
