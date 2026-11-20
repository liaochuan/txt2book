// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deriveConfigKey, encryptSaved, decryptSaved } from "../../server/lib/calibre/crypto";
import { createCalibreStore } from "../../server/lib/calibre/store";

const KEY = deriveConfigKey("s".repeat(32));
const PAYLOAD = { baseUrl: "https://books.example.com", username: "alice", password: "s3cret" };
const dirs: string[] = [];

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "calibre-store-"));
  dirs.push(dir);
  return join(dir, "nested", "calibre.json");
}
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("crypto", () => {
  it("round-trips and never writes plaintext fields", async () => {
    const file = encryptSaved(PAYLOAD, KEY);
    expect(JSON.stringify(file)).not.toContain("s3cret");
    expect(decryptSaved(file, KEY)).toEqual(PAYLOAD);
  });
  it("returns null for a wrong key or tampered file", () => {
    const file = encryptSaved(PAYLOAD, KEY);
    expect(decryptSaved(file, deriveConfigKey("x".repeat(32)))).toBeNull();
    expect(decryptSaved({ ...file, tag: Buffer.alloc(16).toString("base64") }, KEY)).toBeNull();
  });
});

describe("store", () => {
  it("saves atomically and loads", async () => {
    const path = await tempPath();
    const store = createCalibreStore({ path, key: KEY, enabled: true });
    expect(await store.saveSaved(PAYLOAD)).toBe(true);
    expect(await store.loadSaved()).toEqual(PAYLOAD);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("s3cret");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it("ignores corrupt files and keeps them", async () => {
    const path = await tempPath();
    const store = createCalibreStore({ path, key: KEY, enabled: true });
    await store.saveSaved(PAYLOAD);
    await writeFile(path, "{not json");
    expect(await store.loadSaved()).toBeNull();
    expect(await readFile(path, "utf8")).toBe("{not json");
  });
  it("returns false when the path cannot be written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "calibre-store-"));
    dirs.push(dir);
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "file");
    const store = createCalibreStore({
      path: join(blocker, "calibre.json"), key: KEY, enabled: true,
    });
    expect(await store.saveSaved(PAYLOAD)).toBe(false);
  });
  it("does nothing when disabled", async () => {
    const path = await tempPath();
    const store = createCalibreStore({ path, key: null, enabled: false });
    expect(await store.saveSaved(PAYLOAD)).toBe(false);
    expect(await store.loadSaved()).toBeNull();
  });
});
