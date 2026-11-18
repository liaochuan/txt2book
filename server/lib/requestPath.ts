/**
 * 请求目标路径归一化（安全关键）。
 *
 * 路由器（find-my-way）在匹配前会解析 absolute-form 目标并做一次百分号解码，
 * 因此安全判断不能直接拿 `request.url` 做前缀比较，否则
 * `POST /%61pi/cover/from-url`、`POST http://host/api/...` 等写法会绕过 `/api` 守卫。
 * 守卫与 404 处理器必须共用本函数，保证二者对「同一个请求是什么路径」的判断一致。
 *
 * 归一化步骤：
 * 1. 去掉 query（及 fragment，防御非标准目标）；
 * 2. absolute-form（`http://host/path`）取出 pathname，并标记 `suspicious`；
 * 3. 百分号解码一次；解码失败标记 `suspicious` 并使用按 API 处理的哨兵路径（fail closed）；
 * 4. 合并重复斜杠、去掉单条尾部斜杠（根路径除外）。
 *
 * `suspicious` 为 true 时调用方应 fail closed：守卫对未认证请求直接 401，
 * 404 处理器按 API 返回 JSON。
 */

export interface NormalizedRequestPath {
  /** 归一化后的路径，始终以 `/` 开头，不含 query。 */
  path: string;
  /** 目标形式异常（absolute-form 或解码失败），调用方应 fail closed。 */
  suspicious: boolean;
}

/** absolute-form 请求目标：`scheme://...`（RFC 9112 允许代理这样发送）。 */
const ABSOLUTE_FORM = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** 解码失败时的哨兵路径：以 `/api` 开头，确保按受保护接口处理。 */
const DECODE_FAILURE_PATH = "/api/__invalid_request_target__";

/** `/api` 与其子路径；`/apifoo` 不算 API。 */
export function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/** 合并重复斜杠并去掉尾部斜杠；空路径归一化为根路径。 */
function normalizeSlashes(value: string): string {
  let path = value === "" ? "/" : value;
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

/** 解析并归一化原始请求目标。 */
export function normalizeRequestPath(rawUrl: string): NormalizedRequestPath {
  const queryIndex = rawUrl.indexOf("?");
  let target = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const fragmentIndex = target.indexOf("#");
  if (fragmentIndex !== -1) target = target.slice(0, fragmentIndex);

  let suspicious = false;

  if (ABSOLUTE_FORM.test(target)) {
    suspicious = true;
    try {
      target = new URL(target).pathname;
    } catch {
      target = DECODE_FAILURE_PATH;
    }
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    suspicious = true;
    decoded = DECODE_FAILURE_PATH;
  }

  const path = normalizeSlashes(decoded);

  // 原始（未解码）路径以 /api 开头时也按 API 处理：正常情况下解码不会改变这个前缀，
  // 这里保留双向检查，避免未来归一化步骤变化后出现「原始是 API、解码后不是」的缝隙。
  const rawPath = normalizeSlashes(target);
  if (isApiPath(rawPath) && !isApiPath(path)) suspicious = true;

  return { path, suspicious };
}
