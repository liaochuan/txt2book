/**
 * 生成 `AUTH_PASSWORD_HASH`。
 *
 * 用法：`npm run hash-password -- <密码>`，或 `echo <密码> | npm run hash-password`。
 * 只输出哈希，不输出明文，也不在终端里回显输入。
 */
import { hashPassword } from "../lib/password.js";

/** 读取标准输入的全部内容；TTY 交互下不尝试读取，避免挂起。 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 去掉行尾所有换行，保留密码本身的其他空白。 */
function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n+$/, "");
}

async function main(): Promise<void> {
  const fromArgv = process.argv[2];
  const raw = fromArgv !== undefined && fromArgv !== "" ? fromArgv : await readStdin();
  const plain = stripTrailingNewline(raw);

  if (plain.trim() === "") {
    console.error("密码不能为空。用法：npm run hash-password -- <密码>，或通过标准输入传入。");
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${await hashPassword(plain)}\n`);
}

main().catch((error: unknown) => {
  console.error("生成密码哈希失败：", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
