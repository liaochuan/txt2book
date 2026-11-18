/**
 * 客户端 IP 提取（设计文档 §13.2 / §13.4）。
 *
 * `request.ip` 由 Fastify 根据 `trustProxy` 计算；这里只做格式与长度防御。
 * 注意：格式校验不解决代理信任问题。开启 `TRUST_PROXY` 时，必须由反向代理
 * 覆盖（而不是追加）`X-Forwarded-For`，否则限流 IP 仍可被伪造。
 */
import { isIP } from "node:net";
import type { FastifyRequest } from "fastify";

/** IP 字符串上限（IPv6 最长 45 字符，留出 IPv4-mapped 前缀等余量）。 */
const MAX_IP_LENGTH = 64;

/** 返回经过格式校验的客户端 IP；无法校验时回退到 socket 地址或 `"unknown"`。 */
export function clientIp(request: FastifyRequest): string {
  const candidate = request.ip;
  if (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= MAX_IP_LENGTH &&
    isIP(candidate) !== 0
  ) {
    return candidate;
  }

  const fallback = request.socket.remoteAddress;
  return typeof fallback === "string" && fallback !== "" ? fallback : "unknown";
}
