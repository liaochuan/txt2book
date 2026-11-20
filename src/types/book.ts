export type Language = "zh-CN" | "en";
export type ChapterKind = "intro" | "chapter" | "extra" | "prologue" | "epilogue";
export type VolumeKind = "volume" | "extra-group";
export type ThemeId = "minimal" | "paper" | "night" | "classic" | "eink";

export interface Chapter {
  id: string;
  title: string;
  originalTitle?: string;
  kind: ChapterKind;
  lines: string[];
  volumeId: string | null;
}

export interface Volume {
  id: string;
  title: string;
  originalTitle?: string;
  kind: VolumeKind;
  lines?: string[];
}

export interface BookMeta {
  title: string;
  author: string;
  language: Language;
  description?: string;
}

export interface CoverAsset {
  png: Uint8Array;
  width: number;
  height: number;
  sourceName?: string;
}

export interface BookSource {
  kind: "calibre-web";
  /** 已连接实例的 origin，用于校验关联是否仍属于当前连接。 */
  origin: string;
  bookId: number;
  title: string;
  formats: string[];
}

export interface BookModel {
  meta: BookMeta;
  volumes: Volume[];
  chapters: Chapter[];
  cover: CoverAsset | null;
  /** calibre-web 等外部来源；本地导入或旧数据为 null。 */
  source?: BookSource | null;
}
