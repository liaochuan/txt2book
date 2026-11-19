// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { buildServer } from "../../server/app";
import { loadConfig, type AppConfig } from "../../server/lib/config";
import { PdfLimitError } from "../../server/lib/pdf/render";
import type { PdfOptions, PdfResult } from "../../server/lib/pdf/types";
import { SESSION_COOKIE, signSession } from "../../server/lib/session";
import type { ExportRouteDeps } from "../../server/routes/export";

const SECRET = "s".repeat(32);
const PDF_BYTES = Buffer.from("%PDF-1.7\n% fake pdf\n%%EOF\n", "latin1");

/** 测试用环境变量：绕过 `NodeJS.ProcessEnv` 的只读索引签名。 */
function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

function makeConfig(): AppConfig {
  return loadConfig(
    env({
      SESSION_SECRET: SECRET,
      AUTH_PASSWORD_HASH: "h",
      AUTH_USERNAME: "admin",
    }),
  );
}

/** 直接签一个合法会话，避免在导出测试里跑 scrypt。 */
function sessionCookie(): string {
  const now = Date.now();
  return `${SESSION_COOKIE}=${signSession({ sub: "admin", iat: now, exp: now + 60_000 }, SECRET)}`;
}

function pdfResult(): PdfResult {
  return { buffer: PDF_BYTES, pageCount: 3, fontFamily: "serif" };
}

async function makeApp(deps: ExportRouteDeps = {}): Promise<FastifyInstance> {
  const app = buildServer(makeConfig(), {
    exportDeps: { renderPdf: async () => pdfResult(), ...deps },
  });
  await app.ready();
  return app;
}

function validPayload(): Record<string, unknown> {
  return {
    book: {
      meta: { title: "测试书", author: "作者" },
      volumes: [],
      chapters: [{ id: "c1", title: "第一章", lines: ["正文第一段", "正文第二段"], volumeId: null }],
    },
    options: { pageSize: "A4", pageNumbers: true },
  };
}

function exportRequest(cookie: string | null = sessionCookie()): {
  method: "POST";
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
} {
  return {
    method: "POST",
    url: "/api/export/pdf",
    headers: cookie === null ? {} : { cookie },
    payload: validPayload(),
  };
}

function errorOf(response: LightMyRequestResponse): { code: string; message: string } {
  return (response.json() as { error: { code: string; message: string } }).error;
}

describe("POST /api/export/pdf", () => {
  it("requires authentication", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject(exportRequest(null));
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe("UNAUTHORIZED");
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("rejects malformed payloads with INVALID_EXPORT", async () => {
    const app = await makeApp();
    try {
      const payloads: unknown[] = [
        {},
        { book: null },
        { book: { meta: {}, chapters: [], volumes: [] } },
        { book: { meta: { title: "书" }, chapters: "no", volumes: [] } },
        { book: { meta: { title: "书" }, chapters: [], volumes: "no" } },
        { book: { meta: { title: "书" }, chapters: [{}], volumes: [] } },
        {
          book: {
            meta: { title: "书" },
            chapters: [{ id: "c1", title: "第一章", lines: [1] }],
            volumes: [],
          },
        },
        { ...validPayload(), options: [] },
      ];

      for (const [index, payload] of payloads.entries()) {
        const res = await app.inject({
          method: "POST",
          url: "/api/export/pdf",
          headers: { cookie: sessionCookie() },
          // 每个畸形请求来自不同 IP，避免 8 次校验失败触发导出限流。
          remoteAddress: `10.20.0.${index + 1}`,
          payload: payload as Record<string, unknown>,
        });
        expect(res.statusCode).toBe(400);
        expect(errorOf(res).code).toBe("INVALID_EXPORT");
        expect(errorOf(res).message).toBe("导出内容无效或过大。");
        expect(res.headers["cache-control"]).toBe("no-store");
      }
    } finally {
      await app.close();
    }
  });

  it("reads layout only from the top level", async () => {
    const received: Array<PdfOptions["layout"]> = [];
    const app = await makeApp({
      renderPdf: async (_book, options) => {
        received.push(options?.layout);
        return pdfResult();
      },
    });
    const topLevel = { marker: "top-level" };

    try {
      const withTopLevel = await app.inject({
        ...exportRequest(),
        payload: {
          ...validPayload(),
          layout: topLevel,
          options: { pageSize: "A5", layout: { marker: "nested" } },
        },
      });
      expect(withTopLevel.statusCode).toBe(200);

      const nestedOnly = await app.inject({
        ...exportRequest(),
        payload: {
          ...validPayload(),
          options: { pageSize: "A5", layout: { marker: "nested" } },
        },
      });
      expect(nestedOnly.statusCode).toBe(200);

      expect(received[0]).toEqual(topLevel);
      expect(received[1]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("maps a body over the 20MB limit to 413 PAYLOAD_TOO_LARGE", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/export/pdf",
        headers: { cookie: sessionCookie() },
        payload: {
          book: {
            meta: { title: "书" },
            volumes: [],
            chapters: [{ id: "c1", title: "第一章", lines: ["x".repeat(21 * 1024 * 1024)] }],
          },
          options: {},
        },
      });

      expect(res.statusCode).toBe(413);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({
        error: { code: "PAYLOAD_TOO_LARGE", message: "请求内容过大。" },
      });
    } finally {
      await app.close();
    }
  });

  it("rejects more than 2000 chapters with EXPORT_TOO_LARGE", async () => {
    const app = await makeApp();
    try {
      const chapters = Array.from({ length: 2001 }, (_, index) => ({
        id: `c${index}`,
        title: `第${index + 1}章`,
        lines: ["x"],
      }));
      const res = await app.inject({
        method: "POST",
        url: "/api/export/pdf",
        headers: { cookie: sessionCookie() },
        payload: {
          book: { meta: { title: "书" }, volumes: [], chapters },
          options: {},
        },
      });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe("EXPORT_TOO_LARGE");
      expect(errorOf(res).message).toBe("导出内容超过大小限制。");
    } finally {
      await app.close();
    }
  });

  it("rejects a chapter longer than 2,000,000 characters", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/export/pdf",
        headers: { cookie: sessionCookie() },
        payload: {
          book: {
            meta: { title: "书" },
            volumes: [],
            chapters: [{ id: "c1", title: "第一章", lines: ["x".repeat(2_000_001)] }],
          },
          options: {},
        },
      });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe("EXPORT_TOO_LARGE");
    } finally {
      await app.close();
    }
  });

  it("returns 429 EXPORT_BUSY while another render is pending", async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const app = await makeApp({
      renderPdf: async () => {
        markStarted();
        await gate;
        return pdfResult();
      },
    });

    try {
      const first = app.inject(exportRequest());
      await started;

      const second = await app.inject(exportRequest());
      expect(second.statusCode).toBe(429);
      expect(errorOf(second).code).toBe("EXPORT_BUSY");
      expect(second.headers["retry-after"]).toBe("5");
      expect(second.headers["cache-control"]).toBe("no-store");

      release();
      const finished = await first;
      expect(finished.statusCode).toBe(200);
    } finally {
      release();
      await app.close();
    }
  });

  it("rate limits the seventh export from one IP", async () => {
    const app = await makeApp();
    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const res = await app.inject(exportRequest());
        expect(res.statusCode).toBe(200);
      }
      const limited = await app.inject(exportRequest());
      expect(limited.statusCode).toBe(429);
      expect(errorOf(limited).code).toBe("RATE_LIMITED");
      expect(limited.headers["retry-after"]).toBe("60");
    } finally {
      await app.close();
    }
  });

  it("returns pdf bytes with download headers", async () => {
    const app = await makeApp();
    try {
      const res = await app.inject(exportRequest());
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["content-disposition"]).toBe('attachment; filename="book.pdf"');
      expect(res.headers["x-pdf-font"]).toBe("serif");
      expect(res.rawPayload.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      await app.close();
    }
  });

  it("maps engine-side PdfLimitError to 400 EXPORT_TOO_LARGE", async () => {
    const app = await makeApp({
      renderPdf: async () => {
        throw new PdfLimitError();
      },
    });

    try {
      const res = await app.inject(exportRequest());
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe("EXPORT_TOO_LARGE");
      expect(errorOf(res).message).toBe("导出内容超过大小限制。");
      expect(res.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("returns 504 EXPORT_TIMEOUT when rendering exceeds 60 seconds", async () => {
    const app = await makeApp({
      renderPdf: () => new Promise<PdfResult>(() => undefined),
    });

    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = app.inject(exportRequest());
      let settled = false;
      let response: LightMyRequestResponse | undefined;
      void pending.then(
        (value) => {
          settled = true;
          response = value;
        },
        () => undefined,
      );

      // 处理器的 60s 定时器可能在首个微任务批次之后才注册，多推进几轮确保触发。
      for (let attempt = 0; attempt < 5 && !settled; attempt += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
      }

      expect(settled).toBe(true);
      expect(response?.statusCode).toBe(504);
      expect(response === undefined ? "" : errorOf(response).code).toBe("EXPORT_TIMEOUT");
      expect(response?.headers["cache-control"]).toBe("no-store");
    } finally {
      vi.useRealTimers();
      await app.close();
    }
  });
});
