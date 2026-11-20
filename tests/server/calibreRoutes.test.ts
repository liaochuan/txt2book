// @vitest-environment node
/**
 * `/api/calibre/*` 路由测试（任务 S7）。
 *
 * service 全部通过 `buildServer` 的 `calibreDeps.service` 注入假实现：
 * 记录调用参数，并按用例抛指定的 `CalibreError` 或未知错误，从而只验证
 * 路由层的校验、限流、响应头与错误映射，不触达真实网络与磁盘。
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../../server/app";
import type {
  CalibreConnectInput,
  CalibreFeedInput,
  CalibreService,
} from "../../server/lib/calibre/service";
import { CalibreError, type CalibreSessionInfo } from "../../server/lib/calibre/types";
import { loadConfig } from "../../server/lib/config";
import { SESSION_COOKIE, signSession } from "../../server/lib/session";

const SECRET = "s".repeat(32);

const SESSION_INFO: CalibreSessionInfo = {
  connected: true,
  saved: true,
  baseUrl: "http://calibre.local:8083",
  username: "admin",
  canPush: true,
};

const FEED_XML =
  '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';

const TEXT_BYTES = Buffer.from("第一章 正文", "utf8");
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface FakeCalls {
  connect: CalibreConnectInput[];
  resume: number;
  disconnect: number;
  forget: number;
  feed: CalibreFeedInput[];
  textFile: number[];
  coverPng: number[];
  pushEpub: Array<{ bookId: number; data: Buffer; filename: string; overwrite: boolean }>;
  clearLive: number;
}

interface FakeService {
  service: CalibreService;
  calls: FakeCalls;
}

/** 构造一个默认全部成功的假 service；`overrides` 覆盖单个方法。 */
function makeFake(overrides: Partial<CalibreService> = {}): FakeService {
  const calls: FakeCalls = {
    connect: [],
    resume: 0,
    disconnect: 0,
    forget: 0,
    feed: [],
    textFile: [],
    coverPng: [],
    pushEpub: [],
    clearLive: 0,
  };

  const service: CalibreService = {
    status: async () => SESSION_INFO,
    connect: async (input) => {
      calls.connect.push(input);
      return SESSION_INFO;
    },
    resume: async () => {
      calls.resume += 1;
      return SESSION_INFO;
    },
    disconnect: () => {
      calls.disconnect += 1;
    },
    forget: async () => {
      calls.forget += 1;
    },
    feed: async (input) => {
      calls.feed.push(input);
      return FEED_XML;
    },
    textFile: async (bookId) => {
      calls.textFile.push(bookId);
      return TEXT_BYTES;
    },
    coverPng: async (bookId) => {
      calls.coverPng.push(bookId);
      return PNG_BYTES;
    },
    pushEpub: async (bookId, data, filename, overwrite) => {
      calls.pushEpub.push({ bookId, data, filename, overwrite });
    },
    clearLive: () => {
      calls.clearLive += 1;
    },
    ...overrides,
  };

  return { service, calls };
}

/** 测试用环境变量：绕过 `NodeJS.ProcessEnv` 的只读索引签名。 */
function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

interface MakeAppOptions {
  env?: Record<string, string>;
  fake?: FakeService;
  now?: () => number;
}

async function makeApp(
  options: MakeAppOptions = {},
): Promise<{ app: FastifyInstance; fake: FakeService }> {
  const fake = options.fake ?? makeFake();
  const config = loadConfig(
    env({
      SESSION_SECRET: SECRET,
      AUTH_PASSWORD_HASH: "h",
      AUTH_USERNAME: "admin",
      ...options.env,
    }),
  );
  const app = buildServer(config, {
    calibreDeps: {
      service: fake.service,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  });
  await app.ready();
  return { app, fake };
}

/** 直接签一个合法会话，避免路由测试执行 scrypt。 */
function sessionCookie(): string {
  const now = Date.now();
  return `${SESSION_COOKIE}=${signSession(
    { sub: "admin", iat: now, exp: now + 60_000 },
    SECRET,
  )}`;
}

function errorBody(res: { json: () => unknown }): { code: string; message: string } {
  const parsed = res.json() as { error: { code: string; message: string } };
  return parsed.error;
}

interface MultipartPayload {
  boundary: string;
  body: Buffer;
}

/** 构造单文件 multipart 请求体；默认字段名 `file`、文件名 `book.epub`。 */
function multipartFile(
  file: Buffer,
  options: { filename?: string; field?: string; contentType?: string } = {},
): MultipartPayload {
  const boundary = "----txt2book-calibre-test";
  const filename = options.filename ?? "book.epub";
  const field = options.field ?? "file";
  const contentType = options.contentType ?? "application/epub+zip";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { boundary, body: Buffer.concat([head, file, tail]) };
}

describe("calibre 路由认证", () => {
  it("未登录访问 /api/calibre/* 返回 401", async () => {
    const { app } = await makeApp();
    try {
      const requests = [
        { method: "GET" as const, url: "/api/calibre/session" },
        { method: "GET" as const, url: "/api/calibre/feed" },
        { method: "GET" as const, url: "/api/calibre/books/1/cover" },
        {
          method: "POST" as const,
          url: "/api/calibre/session",
          payload: { baseUrl: "http://calibre.local:8083", username: "u", password: "p" },
        },
        { method: "DELETE" as const, url: "/api/calibre/credentials" },
      ];

      for (const request of requests) {
        const res = await app.inject(request);
        expect(res.statusCode).toBe(401);
        expect(errorBody(res).code).toBe("UNAUTHORIZED");
      }
    } finally {
      await app.close();
    }
  });
});

describe("calibre 会话接口", () => {
  it("GET /session 透传 CalibreSessionInfo 且不缓存", async () => {
    const { app } = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calibre/session",
        headers: { cookie: sessionCookie() },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(SESSION_INFO);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("POST /session 成功时连接并返回完整状态", async () => {
    const { app, fake } = await makeApp();
    try {
      const body = {
        baseUrl: "http://calibre.local:8083",
        username: "admin",
        password: "secret",
      };
      const res = await app.inject({
        method: "POST",
        url: "/api/calibre/session",
        headers: { cookie: sessionCookie() },
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        connected: true,
        saved: true,
        baseUrl: "http://calibre.local:8083",
        username: "admin",
      });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(fake.calls.connect).toEqual([body]);
    } finally {
      await app.close();
    }
  });

  it("POST /session 校验 body：缺字段、超长、额外字段都返回统一 400", async () => {
    const { app, fake } = await makeApp();
    try {
      const valid = {
        baseUrl: "http://calibre.local:8083",
        username: "admin",
        password: "secret",
      };
      const payloads: unknown[] = [
        {},
        { baseUrl: valid.baseUrl },
        { username: valid.username, password: valid.password },
        { ...valid, baseUrl: "" },
        { ...valid, username: "" },
        { ...valid, password: "" },
        { ...valid, baseUrl: `http://calibre.local/${"a".repeat(2048)}` },
        { ...valid, username: "u".repeat(257) },
        { ...valid, password: "p".repeat(1025) },
        { ...valid, extra: "x" },
        { ...valid, username: { nested: true } },
      ];

      for (const payload of payloads) {
        const res = await app.inject({
          method: "POST",
          url: "/api/calibre/session",
          headers: { cookie: sessionCookie() },
          payload: payload as Record<string, unknown>,
        });
        expect(res.statusCode).toBe(400);
        expect(errorBody(res).code).toBe("CALIBRE_INVALID_REQUEST");
        expect(res.headers["cache-control"]).toBe("no-store");
      }

      expect(fake.calls.connect).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("POST /session/reconnect 无 body 时用已保存配置重连", async () => {
    const { app, fake } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/calibre/session/reconnect",
        headers: { cookie: sessionCookie() },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(SESSION_INFO);
      expect(fake.calls.resume).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("DELETE /session 只断开连接，DELETE /credentials 删除配置", async () => {
    const { app, fake } = await makeApp();
    try {
      const disconnect = await app.inject({
        method: "DELETE",
        url: "/api/calibre/session",
        headers: { cookie: sessionCookie() },
      });
      expect(disconnect.statusCode).toBe(204);
      expect(disconnect.headers["cache-control"]).toBe("no-store");
      expect(fake.calls.disconnect).toBe(1);

      const forget = await app.inject({
        method: "DELETE",
        url: "/api/calibre/credentials",
        headers: { cookie: sessionCookie() },
      });
      expect(forget.statusCode).toBe(204);
      expect(fake.calls.forget).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("POST /api/auth/logout 清理内存连接", async () => {
    const { app, fake } = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie: sessionCookie() },
      });

      expect(res.statusCode).toBe(204);
      expect(fake.calls.clearLive).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe("calibre 书单与下载接口", () => {
  it("GET /feed 返回 atom+xml 并透传 XML", async () => {
    const { app, fake } = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calibre/feed",
        headers: { cookie: sessionCookie() },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("atom+xml");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(res.body).toBe(FEED_XML);
      expect(fake.calls.feed).toEqual([{}]);
    } finally {
      await app.close();
    }
  });

  it("GET /feed 归一化查询参数：空 format 传 undefined，offset 转数字", async () => {
    const { app, fake } = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calibre/feed?offset=120&format=",
        headers: { cookie: sessionCookie() },
      });

      expect(res.statusCode).toBe(200);
      expect(fake.calls.feed).toEqual([{ offset: 120, format: undefined }]);
    } finally {
      await app.close();
    }
  });

  it("GET /feed 拒绝非法查询参数", async () => {
    const { app, fake } = await makeApp();
    try {
      const urls = [
        "/api/calibre/feed?offset=-1",
        "/api/calibre/feed?offset=abc",
        "/api/calibre/feed?offset=1.5",
        "/api/calibre/feed?offset=99999999999999999999",
        `/api/calibre/feed?q=${"q".repeat(201)}`,
        `/api/calibre/feed?format=${"f".repeat(17)}`,
        "/api/calibre/feed?q=a&q=b",
        "/api/calibre/feed?format=txt&format=epub",
      ];

      for (const url of urls) {
        const res = await app.inject({
          method: "GET",
          url,
          headers: { cookie: sessionCookie() },
        });
        expect(res.statusCode).toBe(400);
        expect(errorBody(res).code).toBe("CALIBRE_INVALID_REQUEST");
      }

      expect(fake.calls.feed).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("GET /books/:id/file?format=txt 返回字节", async () => {
    const { app, fake } = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calibre/books/7/file?format=txt",
        headers: { cookie: sessionCookie() },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/octet-stream");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.rawPayload.equals(TEXT_BYTES)).toBe(true);
      expect(fake.calls.textFile).toEqual([7]);
    } finally {
      await app.close();
    }
  });

  it("GET /books/:id/file 的 format 只允许 txt（大小写不敏感）", async () => {
    const { app, fake } = await makeApp();
    try {
      const epub = await app.inject({
        method: "GET",
        url: "/api/calibre/books/7/file?format=epub",
        headers: { cookie: sessionCookie() },
      });
      expect(epub.statusCode).toBe(400);
      expect(errorBody(epub).code).toBe("CALIBRE_INVALID_REQUEST");

      const upper = await app.inject({
        method: "GET",
        url: "/api/calibre/books/7/file?format=TXT",
        headers: { cookie: sessionCookie() },
      });
      expect(upper.statusCode).toBe(200);
      expect(fake.calls.textFile).toEqual([7]);
    } finally {
      await app.close();
    }
  });

  it("拒绝非法书籍 id", async () => {
    const { app, fake } = await makeApp();
    try {
      for (const id of ["0", "-1", "abc", "1.5"]) {
        const res = await app.inject({
          method: "GET",
          url: `/api/calibre/books/${id}/cover`,
          headers: { cookie: sessionCookie() },
        });
        expect(res.statusCode).toBe(400);
        expect(errorBody(res).code).toBe("CALIBRE_INVALID_REQUEST");
      }
      expect(fake.calls.coverPng).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("GET /books/:id/cover 返回 PNG", async () => {
    const { app, fake } = await makeApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calibre/books/7/cover",
        headers: { cookie: sessionCookie() },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("image/png");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.rawPayload.equals(PNG_BYTES)).toBe(true);
      expect(fake.calls.coverPng).toEqual([7]);
    } finally {
      await app.close();
    }
  });
});

describe("calibre 推送接口", () => {
  it("POST /books/:id/epub 上传 multipart 文件并透传 overwrite", async () => {
    const { app, fake } = await makeApp();
    try {
      const epub = Buffer.from("PK\u0003\u0004fake epub", "binary");
      const { boundary, body } = multipartFile(epub);
      const res = await app.inject({
        method: "POST",
        url: "/api/calibre/books/7/epub?overwrite=true",
        headers: {
          cookie: sessionCookie(),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });

      expect(res.statusCode).toBe(204);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(fake.calls.pushEpub).toHaveLength(1);
      const call = fake.calls.pushEpub[0];
      expect(call?.bookId).toBe(7);
      expect(call?.filename).toBe("book.epub");
      expect(call?.overwrite).toBe(true);
      expect(call?.data.equals(epub)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("overwrite 缺省为 false，且只接受 true/false", async () => {
    const { app, fake } = await makeApp();
    try {
      const epub = Buffer.from("PK\u0003\u0004fake epub", "binary");
      const { boundary, body } = multipartFile(epub);
      const ok = await app.inject({
        method: "POST",
        url: "/api/calibre/books/3/epub",
        headers: {
          cookie: sessionCookie(),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });
      expect(ok.statusCode).toBe(204);
      expect(fake.calls.pushEpub[0]?.overwrite).toBe(false);

      for (const raw of ["1", "yes", "TRUE ", ""]) {
        const res = await app.inject({
          method: "POST",
          url: `/api/calibre/books/3/epub?overwrite=${encodeURIComponent(raw)}`,
          headers: {
            cookie: sessionCookie(),
            "content-type": `multipart/form-data; boundary=${boundary}`,
          },
          payload: body,
        });
        expect(res.statusCode).toBe(400);
        expect(errorBody(res).code).toBe("CALIBRE_INVALID_REQUEST");
      }

      expect(fake.calls.pushEpub).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("非 multipart 或缺少 file 字段返回 400", async () => {
    const { app, fake } = await makeApp();
    try {
      const json = await app.inject({
        method: "POST",
        url: "/api/calibre/books/7/epub",
        headers: { cookie: sessionCookie() },
        payload: { file: "nope" },
      });
      expect(json.statusCode).toBe(400);
      expect(errorBody(json).code).toBe("CALIBRE_INVALID_REQUEST");

      const epub = Buffer.from("PK", "binary");
      const { boundary, body } = multipartFile(epub, { field: "avatar", filename: "book.epub" });
      const wrongField = await app.inject({
        method: "POST",
        url: "/api/calibre/books/7/epub",
        headers: {
          cookie: sessionCookie(),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });
      expect(wrongField.statusCode).toBe(400);
      expect(errorBody(wrongField).code).toBe("CALIBRE_INVALID_REQUEST");

      expect(fake.calls.pushEpub).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("文件名必须以 .epub 结尾（大小写不敏感）", async () => {
    const { app, fake } = await makeApp();
    try {
      const epub = Buffer.from("PK", "binary");
      const rejected = multipartFile(epub, { filename: "book.txt" });
      const bad = await app.inject({
        method: "POST",
        url: "/api/calibre/books/7/epub",
        headers: {
          cookie: sessionCookie(),
          "content-type": `multipart/form-data; boundary=${rejected.boundary}`,
        },
        payload: rejected.body,
      });
      expect(bad.statusCode).toBe(400);
      expect(errorBody(bad).code).toBe("CALIBRE_INVALID_REQUEST");

      const accepted = multipartFile(epub, { filename: "BOOK.EPUB" });
      const ok = await app.inject({
        method: "POST",
        url: "/api/calibre/books/7/epub",
        headers: {
          cookie: sessionCookie(),
          "content-type": `multipart/form-data; boundary=${accepted.boundary}`,
        },
        payload: accepted.body,
      });
      expect(ok.statusCode).toBe(204);
      expect(fake.calls.pushEpub[0]?.filename).toBe("BOOK.EPUB");
    } finally {
      await app.close();
    }
  });

  it("超过 CALIBRE_MAX_PUSH_BYTES 返回 413 CALIBRE_TOO_LARGE", async () => {
    const { app, fake } = await makeApp({ env: { CALIBRE_MAX_PUSH_BYTES: "64" } });
    try {
      const { boundary, body } = multipartFile(Buffer.alloc(128, 1));
      const res = await app.inject({
        method: "POST",
        url: "/api/calibre/books/7/epub",
        headers: {
          cookie: sessionCookie(),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });

      expect(res.statusCode).toBe(413);
      expect(errorBody(res).code).toBe("CALIBRE_TOO_LARGE");
      expect(res.body).not.toContain("FST_");
      expect(fake.calls.pushEpub).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("推送限流：第 7 次返回 429", async () => {
    const { app } = await makeApp();
    try {
      const epub = Buffer.from("PK", "binary");
      const { boundary, body } = multipartFile(epub);
      const headers = {
        cookie: sessionCookie(),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      };

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/api/calibre/books/7/epub",
          headers,
          payload: body,
        });
        expect(res.statusCode).toBe(204);
      }

      const limited = await app.inject({
        method: "POST",
        url: "/api/calibre/books/7/epub",
        headers,
        payload: body,
      });
      expect(limited.statusCode).toBe(429);
      expect(errorBody(limited).code).toBe("CALIBRE_RATE_LIMITED");
      expect(limited.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
});

describe("calibre 错误映射", () => {
  it("CalibreError 透传状态码与代码", async () => {
    const fake = makeFake({
      textFile: async () => {
        throw new CalibreError("CALIBRE_NOT_FOUND", 404, "未找到指定的图书。");
      },
    });
    const { app } = await makeApp({ fake });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calibre/books/9/file?format=txt",
        headers: { cookie: sessionCookie() },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({
        error: { code: "CALIBRE_NOT_FOUND", message: "未找到指定的图书。" },
      });
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("上游认证失败映射为 400，绝不返回 401", async () => {
    const fake = makeFake({
      feed: async () => {
        throw new CalibreError("CALIBRE_AUTH_FAILED", 400, "calibre-web 账号或密码错误。");
      },
    });
    const { app } = await makeApp({ fake });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calibre/feed",
        headers: { cookie: sessionCookie() },
      });

      expect(res.statusCode).toBe(400);
      expect(errorBody(res).code).toBe("CALIBRE_AUTH_FAILED");
      expect(res.headers["set-cookie"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("未知错误返回 502 CALIBRE_UPSTREAM 且不泄露内部消息", async () => {
    const fake = makeFake({
      coverPng: async () => {
        throw new Error("internal detail: 10.0.0.1 leaked");
      },
    });
    const { app } = await makeApp({ fake });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/api/calibre/books/9/cover",
        headers: { cookie: sessionCookie() },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({
        error: { code: "CALIBRE_UPSTREAM", message: "无法访问 calibre-web，请稍后重试。" },
      });
      expect(res.body).not.toContain("internal detail");
      expect(res.body).not.toContain("10.0.0.1");
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });
});

describe("calibre 限流", () => {
  it("连接限流：同一 IP 第 6 次返回 429，失败尝试也计数，窗口过后恢复", async () => {
    let clock = 1_000_000;
    const failingConnect = async (_input: CalibreConnectInput): Promise<CalibreSessionInfo> => {
      throw new CalibreError("CALIBRE_AUTH_FAILED", 400, "calibre-web 账号或密码错误。");
    };
    const fake = makeFake({ connect: failingConnect });
    const { app } = await makeApp({ fake, now: () => clock });
    try {
      const body = {
        baseUrl: "http://calibre.local:8083",
        username: "admin",
        password: "wrong",
      };
      const headers = { cookie: sessionCookie() };

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await app.inject({
          method: "POST",
          url: "/api/calibre/session",
          headers,
          payload: body,
        });
        expect(res.statusCode).toBe(400);
        expect(errorBody(res).code).toBe("CALIBRE_AUTH_FAILED");
      }

      const limited = await app.inject({
        method: "POST",
        url: "/api/calibre/session",
        headers,
        payload: body,
      });
      expect(limited.statusCode).toBe(429);
      expect(errorBody(limited).code).toBe("CALIBRE_RATE_LIMITED");
      expect(limited.headers["cache-control"]).toBe("no-store");
      expect(limited.headers["retry-after"]).toBe("60");

      // 注入的时钟前进一个窗口后重新允许尝试。
      clock += 61_000;
      const recovered = await app.inject({
        method: "POST",
        url: "/api/calibre/session",
        headers,
        payload: body,
      });
      expect(recovered.statusCode).toBe(400);
      expect(errorBody(recovered).code).toBe("CALIBRE_AUTH_FAILED");
    } finally {
      await app.close();
    }
  });

  it("读取限流：超过 CALIBRE_RATE_LIMIT_PER_MIN 返回 429", async () => {
    const { app } = await makeApp({ env: { CALIBRE_RATE_LIMIT_PER_MIN: "2" } });
    try {
      const headers = { cookie: sessionCookie() };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const res = await app.inject({ method: "GET", url: "/api/calibre/feed", headers });
        expect(res.statusCode).toBe(200);
      }

      const limited = await app.inject({ method: "GET", url: "/api/calibre/feed", headers });
      expect(limited.statusCode).toBe(429);
      expect(errorBody(limited).code).toBe("CALIBRE_RATE_LIMITED");
    } finally {
      await app.close();
    }
  });
});
