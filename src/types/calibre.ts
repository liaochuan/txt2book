export interface CalibreBook {
  id: number;
  title: string;
  authors: string[];
  language?: string;
  summary: string;
  formats: string[];
  hasCover: boolean;
  /** entry 的 `<updated>` 原始值；缺失或非法时保持 undefined。 */
  updated?: string;
}

export interface CalibreFeed {
  books: CalibreBook[];
  nextOffset: number | null;
  /** 由 feed 的 `rel="self"` 链接推断的来源。 */
  source: "new" | "books" | "format" | "search" | "unknown";
}

/** 导出 EPUB 时如何对待 calibre-web 推送。 */
export type CalibrePushMode = "off" | "download-and-push" | "push-only";

export interface CalibreSessionInfo {
  connected: boolean;
  saved: boolean;
  baseUrl?: string;
  username?: string;
  canPush?: boolean;
  pushReason?: string;
}
