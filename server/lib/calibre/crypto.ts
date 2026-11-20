/**
 * calibre-web 连接凭据的对称加密。
 *
 * `SESSION_SECRET` 经 HKDF-SHA256 派生 32 字节密钥；载荷用 AES-256-GCM 加密，
 * 每次生成随机 12 字节 IV。磁盘上只有 `version`、`iv`、`tag`、`data`，不含任何
 * 明文地址、账号或密码。
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { SavedCalibreFile, SavedCalibrePayload } from "./types.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_SALT = "txt2book";
const HKDF_INFO = "calibre-credentials";
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** 从 `SESSION_SECRET` 派生 AES-256-GCM 密钥。 */
export function deriveConfigKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionSecret, HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

/** 严格解码 base64；格式非法或解码后长度不符时返回 `null`。 */
function decodeBase64(value: unknown, expectedBytes?: number): Buffer | null {
  if (typeof value !== "string" || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    return null;
  }
  const buffer = Buffer.from(value, "base64");
  if (expectedBytes !== undefined && buffer.length !== expectedBytes) return null;
  return buffer;
}

/** 校验解密结果的结构，避免把任意 JSON 当作有效凭据。 */
function parsePayload(raw: Buffer): SavedCalibrePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { baseUrl, username, password } = parsed as Record<string, unknown>;
  if (typeof baseUrl !== "string" || typeof username !== "string" || typeof password !== "string") {
    return null;
  }
  return { baseUrl, username, password };
}

/** 加密凭据；随机 IV 保证同一载荷每次输出的密文不同。 */
export function encryptSaved(payload: SavedCalibrePayload, key: Buffer): SavedCalibreFile {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

/** 解密凭据；版本、编码、密钥或认证标签任一不符都返回 `null`。 */
export function decryptSaved(file: SavedCalibreFile, key: Buffer): SavedCalibrePayload | null {
  if (typeof file !== "object" || file === null || file.version !== 1) return null;

  const iv = decodeBase64(file.iv, IV_BYTES);
  const tag = decodeBase64(file.tag, TAG_BYTES);
  const data = decodeBase64(file.data);
  if (iv === null || tag === null || data === null || data.length === 0) return null;

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const raw = Buffer.concat([decipher.update(data), decipher.final()]);
    return parsePayload(raw);
  } catch {
    return null;
  }
}
