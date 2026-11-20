/**
 * calibre-web 连接凭据的加密文件存储。
 *
 * 读取 fail closed：未启用、缺少密钥、文件缺失、JSON 损坏、版本不符或解密失败
 * 一律返回 `null`，且绝不删除或改写已有文件。写入先落到 `<path>.tmp`（0600），
 * 再 `rename` 覆盖，任何一步失败都清理临时文件并返回 `false`。
 * 同一实例内的变更通过 Promise 链串行化，避免并发写互相覆盖。
 */

import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decryptSaved, encryptSaved } from "./crypto.js";
import type { SavedCalibreFile, SavedCalibrePayload } from "./types.js";

export interface CalibreStore {
  loadSaved(): Promise<SavedCalibrePayload | null>;
  saveSaved(payload: SavedCalibrePayload): Promise<boolean>;
  clearSaved(): Promise<void>;
}

export interface CalibreStoreOptions {
  path: string;
  key: Buffer | null;
  enabled: boolean;
}

/** 解析并校验文件结构；结构不符视为损坏，交给上层按失败处理。 */
function parseFile(raw: string): SavedCalibreFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { version, iv, tag, data } = parsed as Record<string, unknown>;
  if (version !== 1) return null;
  if (typeof iv !== "string" || typeof tag !== "string" || typeof data !== "string") return null;
  return { version: 1, iv, tag, data };
}

/** 是否为“文件不存在”。 */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function createCalibreStore(opts: CalibreStoreOptions): CalibreStore {
  const { path, key, enabled } = opts;
  const tmpPath = `${path}.tmp`;

  /** 所有写操作的串行链；失败不打断后续操作。 */
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation, operation);
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    async loadSaved(): Promise<SavedCalibrePayload | null> {
      if (!enabled || key === null) return null;
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch {
        return null;
      }
      const file = parseFile(raw);
      if (file === null) return null;
      return decryptSaved(file, key);
    },

    saveSaved(payload: SavedCalibrePayload): Promise<boolean> {
      if (!enabled || key === null) return Promise.resolve(false);
      return serialize(async () => {
        try {
          const file = encryptSaved(payload, key);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(tmpPath, `${JSON.stringify(file)}\n`, {
            encoding: "utf8",
            mode: 0o600,
          });
          await rename(tmpPath, path);
          return true;
        } catch {
          await rm(tmpPath, { force: true }).catch(() => undefined);
          return false;
        }
      });
    },

    clearSaved(): Promise<void> {
      return serialize(async () => {
        try {
          await unlink(path);
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
      });
    },
  };
}
