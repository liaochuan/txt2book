/**
 * calibre-web 集成的共享类型与错误定义。
 *
 * 错误码同时作为前端可判定的稳定标识，消息统一为中文且不含主机名、IP、
 * 上游 HTML、密码或 Cookie。
 */

export type CalibreErrorCode =
  | "CALIBRE_INVALID_URL"
  | "CALIBRE_INVALID_REQUEST"
  | "CALIBRE_AUTH_FAILED"
  | "CALIBRE_PUSH_UNAVAILABLE"
  | "CALIBRE_PUSH_FORBIDDEN"
  | "CALIBRE_PUSH_METADATA_UNAVAILABLE"
  | "CALIBRE_PUSH_METADATA_FAILED"
  | "CALIBRE_NOT_FOUND"
  | "CALIBRE_FORMAT_UNAVAILABLE"
  | "CALIBRE_NO_COVER"
  | "CALIBRE_NOT_CONNECTED"
  | "CALIBRE_EPUB_EXISTS"
  | "CALIBRE_TOO_LARGE"
  | "CALIBRE_BUSY"
  | "CALIBRE_RATE_LIMITED"
  | "CALIBRE_UNREACHABLE"
  | "CALIBRE_UPSTREAM"
  | "CALIBRE_PUSH_UNVERIFIED"
  | "CALIBRE_TIMEOUT"
  | "CALIBRE_CONFIG";

/** 可映射为 HTTP 响应的 calibre-web 领域错误。 */
export class CalibreError extends Error {
  readonly code: CalibreErrorCode;
  readonly statusCode: number;

  constructor(code: CalibreErrorCode, statusCode: number, message: string) {
    super(message);
    this.name = "CalibreError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

/** 校验通过的 base URL 组成部分：`baseUrl` 不含尾部斜杠，`basePath` 根路径为 `""`。 */
export interface CalibreBase {
  url: URL;
  baseUrl: string;
  origin: string;
  basePath: string;
}

/** 固定连接目标：后续请求直接连接 `address`，`Host` 头保持原域名。 */
export interface CalibreTarget extends CalibreBase {
  address: string;
  family: 4 | 6;
}

/** 持久化的连接凭据；只存在于内存与加密载荷中，绝不落盘为明文。 */
export interface SavedCalibrePayload {
  baseUrl: string;
  username: string;
  password: string;
}

/** 连接凭据文件的磁盘格式；所有二进制字段均为 base64。 */
export interface SavedCalibreFile {
  version: 1;
  iv: string;
  tag: string;
  data: string;
}

/**
 * 进程内 calibre-web 连接状态。
 *
 * 密码与 Cookie 只存在于内存，不写入日志或任何响应；`baseUrl` 不含尾部斜杠，
 * 保留用户填写的子路径。后续请求用 `hostIp` / `family` 固定连接地址，
 * `Host` 头仍来自 `origin`。
 */
export interface CalibreConnection {
  baseUrl: string;
  origin: string;
  basePath: string;
  hostIp: string;
  family: 4 | 6;
  username: string;
  password: string;
  cookies: Map<string, string>;
  canPush: boolean;
  pushReason?: string;
  connectedAt: number;
}

/** 对外会话信息（`GET /session` 的响应体），绝不包含密码。 */
export interface CalibreSessionInfo {
  connected: boolean;
  /** 是否存在可复用的加密配置。 */
  saved: boolean;
  baseUrl?: string;
  username?: string;
  canPush?: boolean;
  pushReason?: string;
}
