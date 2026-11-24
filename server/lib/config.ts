/**
 * 服务端配置：从环境变量读取并校验。
 *
 * 认证配置 fail closed：缺少 `AUTH_PASSWORD_HASH` 或 `SESSION_SECRET` 时拒绝启动，
 * 只有显式设置 `AUTH_DISABLED=true` 才允许在无凭据的情况下运行。
 */

export interface AppConfig {
  port: number;
  username: string;
  passwordHash: string;
  sessionSecret: string;
  sessionTtlDays: number;
  cookieSecure: boolean;
  authDisabled: boolean;
  maxCoverBytes: number;
  coverTimeoutMs: number;
  rateLimitPerMin: number;
  trustProxy: boolean;
  calibreAllowPrivate: boolean;
  calibrePersistCredentials: boolean;
  calibreStorePath: string;
  calibreTimeoutMs: number;
  calibrePushTimeoutMs: number;
  calibreMaxFileBytes: number;
  calibreMaxPushBytes: number;
  calibreRateLimitPerMin: number;
  calibrePushRateLimitPerMin: number;
  calibreConnectRateLimitPerMin: number;
}

const DEFAULT_PORT = 3000;
const DEFAULT_USERNAME = "admin";
const DEFAULT_SESSION_TTL_DAYS = 30;
const DEFAULT_MAX_COVER_BYTES = 10 * 1024 * 1024;
const DEFAULT_COVER_TIMEOUT_MS = 8000;
const DEFAULT_RATE_LIMIT_PER_MIN = 30;
const DEFAULT_CALIBRE_STORE_PATH = "./data/calibre-connection.json";
const DEFAULT_CALIBRE_TIMEOUT_MS = 15_000;
const DEFAULT_CALIBRE_PUSH_TIMEOUT_MS = 120_000;
const DEFAULT_CALIBRE_MAX_FILE_BYTES = 50 * 1024 * 1024;
const DEFAULT_CALIBRE_MAX_PUSH_BYTES = 50 * 1024 * 1024;
const DEFAULT_CALIBRE_RATE_LIMIT_PER_MIN = 120;
const DEFAULT_CALIBRE_PUSH_RATE_LIMIT_PER_MIN = 6;
const DEFAULT_CALIBRE_CONNECT_RATE_LIMIT_PER_MIN = 5;

/** 会话签名密钥的最小长度（设计文档 §13.1 / §16）。 */
const MIN_SESSION_SECRET_LENGTH = 32;

/** 去掉首尾空白；`undefined` 视为空字符串。 */
function readTrimmed(raw: string | undefined): string {
  return (raw ?? "").trim();
}

/** 解析正整数；缺失或非法时回退默认值。 */
function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return fallback;
  return value;
}

/** `PORT` 额外要求落在合法端口区间内。 */
function readPort(raw: string | undefined): number {
  const value = readPositiveInt(raw, DEFAULT_PORT);
  if (value > 65535) return DEFAULT_PORT;
  return value;
}

/** 布尔开关只认显式 `"true"`（大小写不敏感）。 */
function readFlag(raw: string | undefined): boolean {
  return readTrimmed(raw).toLowerCase() === "true";
}

/** 默认开启的布尔开关：只有显式 `"false"` 才关闭（大小写不敏感）。 */
function readDefaultTrueFlag(raw: string | undefined): boolean {
  return readTrimmed(raw).toLowerCase() !== "false";
}

/** 读取字符串配置；纯空白视为未设置，回退默认值。 */
function readString(raw: string | undefined, fallback: string): string {
  const value = readTrimmed(raw);
  return value === "" ? fallback : value;
}

/**
 * 读取认证相关配置：去掉首尾空白与成对的单/双引号。
 *
 * `docker run --env-file` 不会像 Compose 那样剥掉值外层的引号；若 `AUTH_PASSWORD_HASH`
 * 带着引号进入容器，哈希解析会失败，任何密码都会得到 401。
 */
function readAuthValue(raw: string | undefined): string {
  const value = readTrimmed(raw);
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === "'" || quote === '"') && value[value.length - 1] === quote) {
      return value.slice(1, -1).trim();
    }
  }
  return value;
}

/**
 * 读取 `AUTH_PASSWORD_HASH`：兼容 Compose 的 `$` 转义写法。
 *
 * Compose 要求把 `$` 写成 `$$`，但只有发生插值的场景才会还原；`env_file` 的
 * `format: raw` 与 `docker run --env-file` 会把 `$$` 原样传进容器。scrypt 哈希
 * 不会出现空的 `$$` 字段，因此这里统一还原，两种写法都能用。
 */
function readPasswordHash(raw: string | undefined): string {
  return readAuthValue(raw).replace(/\$\$/g, "$");
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const authDisabled = readFlag(env.AUTH_DISABLED);
  const passwordHash = readPasswordHash(env.AUTH_PASSWORD_HASH);
  const sessionSecret = readAuthValue(env.SESSION_SECRET);
  const username = readAuthValue(env.AUTH_USERNAME);

  if (!authDisabled) {
    const missing: string[] = [];
    if (sessionSecret === "") missing.push("SESSION_SECRET");
    if (passwordHash === "") missing.push("AUTH_PASSWORD_HASH");
    if (missing.length > 0) {
      throw new Error(
        `缺少必需的环境变量：${missing.join("、")}。请配置后重启；仅本地开发可显式设置 AUTH_DISABLED=true。`,
      );
    }
    if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
      throw new Error(`SESSION_SECRET 至少需要 ${MIN_SESSION_SECRET_LENGTH} 个字符，请在部署时生成足够长的随机值。`);
    }
  }

  return {
    port: readPort(env.PORT),
    username: username === "" ? DEFAULT_USERNAME : username,
    passwordHash,
    sessionSecret,
    sessionTtlDays: readPositiveInt(env.SESSION_TTL_DAYS, DEFAULT_SESSION_TTL_DAYS),
    cookieSecure: readFlag(env.COOKIE_SECURE),
    authDisabled,
    maxCoverBytes: readPositiveInt(env.MAX_COVER_BYTES, DEFAULT_MAX_COVER_BYTES),
    coverTimeoutMs: readPositiveInt(env.COVER_TIMEOUT_MS, DEFAULT_COVER_TIMEOUT_MS),
    rateLimitPerMin: readPositiveInt(env.RATE_LIMIT_PER_MIN, DEFAULT_RATE_LIMIT_PER_MIN),
    trustProxy: readFlag(env.TRUST_PROXY),
    calibreAllowPrivate: readDefaultTrueFlag(env.CALIBRE_ALLOW_PRIVATE),
    calibrePersistCredentials: readDefaultTrueFlag(env.CALIBRE_PERSIST_CREDENTIALS),
    calibreStorePath: readString(env.CALIBRE_STORE_PATH, DEFAULT_CALIBRE_STORE_PATH),
    calibreTimeoutMs: readPositiveInt(env.CALIBRE_TIMEOUT_MS, DEFAULT_CALIBRE_TIMEOUT_MS),
    calibrePushTimeoutMs: readPositiveInt(
      env.CALIBRE_PUSH_TIMEOUT_MS,
      DEFAULT_CALIBRE_PUSH_TIMEOUT_MS,
    ),
    calibreMaxFileBytes: readPositiveInt(env.CALIBRE_MAX_FILE_BYTES, DEFAULT_CALIBRE_MAX_FILE_BYTES),
    calibreMaxPushBytes: readPositiveInt(env.CALIBRE_MAX_PUSH_BYTES, DEFAULT_CALIBRE_MAX_PUSH_BYTES),
    calibreRateLimitPerMin: readPositiveInt(
      env.CALIBRE_RATE_LIMIT_PER_MIN,
      DEFAULT_CALIBRE_RATE_LIMIT_PER_MIN,
    ),
    calibrePushRateLimitPerMin: readPositiveInt(
      env.CALIBRE_PUSH_RATE_LIMIT_PER_MIN,
      DEFAULT_CALIBRE_PUSH_RATE_LIMIT_PER_MIN,
    ),
    calibreConnectRateLimitPerMin: readPositiveInt(
      env.CALIBRE_CONNECT_RATE_LIMIT_PER_MIN,
      DEFAULT_CALIBRE_CONNECT_RATE_LIMIT_PER_MIN,
    ),
  };
}
