/**
 * 会话 Cookie 的签发与校验（设计文档 §13.2）。
 *
 * 服务端不保存会话表：令牌形如 `base64url(JSON payload).base64url(HMAC-SHA256)`，
 * 由 `SESSION_SECRET` 签名，签名比较使用 `timingSafeEqual`。
 * 任何畸形输入（缺段、非法 base64url、JSON 结构不符、签名不匹配、已过期）一律返回 `null`，
 * 不抛异常，避免把内部错误暴露给路由。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** 会话 Cookie 名（设计文档 §13.2）。 */
export const SESSION_COOKIE = "txt2book_session";

/** 令牌上限：正常令牌约 150 字节，超过此长度直接拒绝，避免对超长输入做 HMAC。 */
const MAX_TOKEN_LENGTH = 4096;

/** 签名密钥最小长度，与 `loadConfig` 的校验保持一致。 */
const MIN_SECRET_LENGTH = 32;

/** 严格的无填充 base64url 字符集。 */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface SessionPayload {
  /** 用户名（`AUTH_USERNAME`）。 */
  sub: string;
  /** 签发时间，Unix 毫秒。 */
  iat: number;
  /** 过期时间，Unix 毫秒。 */
  exp: number;
}

/** 对 payload 段计算 HMAC-SHA256。 */
function computeSignature(payloadPart: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payloadPart, "utf8").digest();
}

/** 签发会话令牌。密钥过短时拒绝签名（fail closed），避免用弱密钥签发令牌。 */
export function signSession(payload: SessionPayload, secret: string): string {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET 至少需要 ${MIN_SECRET_LENGTH} 个字符，拒绝签发会话令牌。`);
  }
  const payloadPart = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = computeSignature(payloadPart, secret).toString("base64url");
  return `${payloadPart}.${signature}`;
}

/** 校验会话令牌；合法且未过期时返回 payload，否则返回 `null`。 */
export function verifySession(
  token: string,
  secret: string,
  now: number = Date.now(),
): SessionPayload | null {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) return null;
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadPart, signaturePart] = parts as [string, string];
  if (payloadPart === "" || signaturePart === "") return null;

  // 严格无填充 base64url：拒绝 `!`、`+`、`/`、`=` 等 `Buffer.from` 会静默忽略的字符，
  // 也拒绝非规范编码，避免同一签名有多种字符串表示。
  if (!BASE64URL_PATTERN.test(signaturePart)) return null;
  const provided = Buffer.from(signaturePart, "base64url");
  if (provided.toString("base64url") !== signaturePart) return null;

  const expected = computeSignature(payloadPart, secret);
  // 长度不等时 `timingSafeEqual` 会抛错，必须先比较长度。
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const { sub, iat, exp } = parsed as Record<string, unknown>;
  if (typeof sub !== "string" || sub === "") return null;
  if (typeof iat !== "number" || !Number.isFinite(iat)) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (exp <= now) return null;

  return { sub, iat, exp };
}
