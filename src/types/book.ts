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

export interface BookModel {
  meta: BookMeta;
  volumes: Volume[];
  chapters: Chapter[];
  cover: CoverAsset | null;
}
