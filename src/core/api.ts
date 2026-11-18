/** 统一的接口错误：`status` 为 HTTP 状态码，网络失败时为 0。 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export interface MeResponse {
  authenticated: boolean;
  username?: string;
}

const DEFAULT_MESSAGES: Record<number, string> = {
  400: "请求参数有误。",
  401: "请先登录。",
  403: "没有访问权限。",
  404: "请求的资源不存在。",
  413: "文件过大。",
  415: "不支持的图片格式。",
  429: "操作过于频繁，请稍后再试。",
};

const NETWORK_MESSAGE = "网络请求失败，请检查网络后重试。";

/** 登录/登出接口的 401 是预期结果，不能触发全局“会话失效”处理。 */
const AUTH_EXEMPT_PATHS = new Set(["/api/auth/login", "/api/auth/logout"]);

let unauthorizedHandler: (() => void) | null = null;

/**
 * 注册会话失效回调：除登录接口外，任意请求返回 401 时同步调用。
 * 传入 `null` 可取消注册。
 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

function statusMessage(status: number): string {
  return DEFAULT_MESSAGES[status] ?? "请求失败，请稍后重试。";
}

interface ErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

/** 非 2xx 时尽力解析 `{error:{code,message}}`，失败则退回状态码。 */
async function toApiError(response: Response): Promise<ApiError> {
  let code = `HTTP_${response.status}`;
  let message = statusMessage(response.status);
  try {
    const body = (await response.json()) as ErrorBody;
    const detail = body?.error;
    if (typeof detail?.code === "string" && detail.code !== "") code = detail.code;
    if (typeof detail?.message === "string" && detail.message !== "") message = detail.message;
  } catch {
    // 错误体不是 JSON 时保留状态码兜底。
  }
  return new ApiError(response.status, code, message);
}

/** 统一请求入口：带 Cookie，网络异常与 HTTP 错误都转成 ApiError。 */
async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiError(0, "NETWORK", NETWORK_MESSAGE);
  }
  if (!response.ok) {
    // 先通知全局会话失效，再解析错误体：错误体读取失败也不影响回调。
    if (response.status === 401 && !AUTH_EXEMPT_PATHS.has(path)) unauthorizedHandler?.();
    throw await toApiError(response);
  }
  return response;
}

function jsonInit(method: string, body: unknown, accept = "application/json"): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", accept },
    body: JSON.stringify(body),
  };
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await request(path, init);
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(response.status, "BAD_RESPONSE", "服务器返回了无法解析的响应。");
  }
}

export interface CoverFileOptions {
  /** 期望的输出格式；jpeg 体积更小，服务端对透明图仍回退 PNG。默认 png。 */
  format?: "png" | "jpeg";
  signal?: AbortSignal;
}

export const api = {
  async me(): Promise<MeResponse> {
    return requestJson<MeResponse>("/api/auth/me", {
      headers: { accept: "application/json" },
      // 登录态必须每次都问服务端，避免浏览器缓存旧结果。
      cache: "no-store",
    });
  },

  async login(username: string, password: string): Promise<void> {
    await request("/api/auth/login", jsonInit("POST", { username, password }));
  },

  async logout(): Promise<void> {
    await request("/api/auth/logout", { method: "POST" });
  },

  async coverFromUrl(url: string, signal?: AbortSignal): Promise<Blob> {
    const response = await request("/api/cover/from-url", {
      ...jsonInit("POST", { url }, "image/png"),
      ...(signal ? { signal } : {}),
    });
    return response.blob();
  },

  async coverFromFile(file: File, options: CoverFileOptions = {}): Promise<Blob> {
    const format = options.format ?? "png";
    const query = format === "jpeg" ? "?format=jpeg" : "";
    const accept = format === "jpeg" ? "image/jpeg, image/png" : "image/png";
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await request(`/api/cover/from-file${query}`, {
      method: "POST",
      headers: { accept },
      body: form,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return response.blob();
  },
};
