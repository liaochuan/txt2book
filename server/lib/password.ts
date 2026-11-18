/**
 * 密码哈希：`node:crypto` 的 scrypt 派生密钥，编码为 `scrypt$N$r$p$saltB64$hashB64`。
 *
 * 设计文档 §13.2 要求用 scrypt 校验密码并用 `timingSafeEqual` 比较；
 * 存储格式损坏时校验一律返回 `false`，不抛出异常，避免把内部错误暴露给登录接口。
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** 存储格式的固定参数（设计文档 §13.1）。 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/**
 * 盐固定 16 字节（128 bit）：随机盐只需唯一性，不需要抵抗离线字典攻击，
 * 该强度已满足需求（设计评审结论）。修改此值会使既有哈希全部失效。
 */
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** 解析存储哈希时允许的参数上限，避免恶意配置触发超大内存分配。 */
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 32;
const MAX_MEMORY_BYTES = 512 * 1024 * 1024;

/** scrypt 的 Promise 包装，固定使用 `Buffer` 输入输出。 */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/** 生成密码哈希；每次调用使用新的随机盐。 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(plain, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEMORY_BYTES,
  });
  return [
    "scrypt",
    SCRYPT_N.toString(),
    SCRYPT_R.toString(),
    SCRYPT_P.toString(),
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

/** 严格解码 base64；非法输入返回 `null`。 */
function decodeBase64(raw: string): Buffer | null {
  if (raw.length === 0 || raw.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const decoded = Buffer.from(raw, "base64");
  // 重新编码必须与原文一致，拒绝 `Buffer.from` 容忍的非规范写法。
  if (decoded.toString("base64") !== raw) return null;
  return decoded;
}

/** 解析正整数参数；非法输入返回 `null`。 */
function readInt(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

/** 解析存储格式；任何字段不合法都返回 `null`。 */
function parseStoredHash(stored: string): ParsedHash | null {
  const fields = stored.split("$");
  if (fields.length !== 6) return null;

  const [scheme, rawN, rawR, rawP, rawSalt, rawKey] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (scheme !== "scrypt") return null;

  const n = readInt(rawN);
  const r = readInt(rawR);
  const p = readInt(rawP);
  if (n === null || r === null || p === null) return null;

  // N 必须是 2 的幂，且参数规模受限。
  if (n < 2 || n > MAX_N || (n & (n - 1)) !== 0) return null;
  if (r > MAX_R || p > MAX_P) return null;
  if (128 * n * r > MAX_MEMORY_BYTES) return null;

  const salt = decodeBase64(rawSalt);
  const key = decodeBase64(rawKey);
  if (salt === null || key === null) return null;
  if (salt.length !== SALT_BYTES || key.length !== KEY_BYTES) return null;

  return { n, r, p, salt, key };
}

/** 校验密码；存储哈希格式损坏或参数非法时返回 `false`，不抛出异常。 */
export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  // 运行时防御：配置值可能来自未做类型校验的调用方。
  if (typeof stored !== "string") return false;

  const parsed = parseStoredHash(stored);
  if (parsed === null) return false;

  let candidate: Buffer;
  try {
    candidate = await scryptAsync(plain, parsed.salt, parsed.key.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEMORY_BYTES,
    });
  } catch {
    return false;
  }

  // 防御性检查：`parseStoredHash` 已保证密钥为 `KEY_BYTES`，派生密钥长度必然相同，
  // 因此这里实际不可达；保留是为了避免将来参数变化时 `timingSafeEqual` 因长度不等而抛错。
  if (candidate.length !== parsed.key.length) return false;
  return timingSafeEqual(candidate, parsed.key);
}
