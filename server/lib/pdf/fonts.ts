import { existsSync } from "node:fs";
import type { PdfFontFile, PdfFontRole, PdfFonts } from "./types.js";

// brief 里字体类型由 `fonts.ts` 导出；这里转出 `types.ts` 的唯一定义。
export type { FontFile, PdfFontFile, PdfFontRole, PdfFonts } from "./types.js";

interface FontCandidate {
  path: string;
  family?: string;
}

/**
 * 中文字体解析（设计文档 §6.2）。
 *
 * 顺序：
 * 1. `PDF_FONT_PATH`（可配 `PDF_FONT_FAMILY`），三个角色共用同一字体；
 * 2. 当前平台的固定候选路径。
 *
 * 缺失的角色回退到第一个可用字体；全部缺失返回 `null`。
 * 字体路径只来自环境变量与固定候选，不接受请求参数。
 */

const WINDOWS_FONTS = "C:\\Windows\\Fonts";

const WINDOWS_CANDIDATES: Record<PdfFontRole, FontCandidate[]> = {
  // `family` 是 TTC/DFont 集合里的 PostScript 名，普通 TTF 不能传。
  serif: [{ path: `${WINDOWS_FONTS}\\simsun.ttc`, family: "SimSun" }],
  sans: [{ path: `${WINDOWS_FONTS}\\simhei.ttf` }],
  kai: [{ path: `${WINDOWS_FONTS}\\simkai.ttf` }],
};

const LINUX_CANDIDATES: Record<PdfFontRole, FontCandidate[]> = {
  serif: [
    {
      path: "/usr/share/fonts/noto/NotoSerifCJK-Regular.ttc",
      family: "NotoSerifCJKsc-Regular",
    },
    {
      path: "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
      family: "NotoSerifCJKsc-Regular",
    },
  ],
  sans: [
    {
      path: "/usr/share/fonts/noto/NotoSansCJK-Regular.ttc",
      family: "NotoSansCJKsc-Regular",
    },
    {
      path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      family: "NotoSansCJKsc-Regular",
    },
  ],
  // Linux 镜像通常没有楷体；回退到 serif。
  kai: [],
};

const MAC_CANDIDATES: Record<PdfFontRole, FontCandidate[]> = {
  serif: [{ path: "/System/Library/Fonts/Songti.ttc", family: "SongtiSC-Regular" }],
  sans: [{ path: "/System/Library/Fonts/PingFang.ttc", family: "PingFangSC-Regular" }],
  // macOS 没有稳定的楷体路径，回退到 serif。
  kai: [],
};

function candidatesForCurrentPlatform(): Record<PdfFontRole, FontCandidate[]> {
  switch (process.platform) {
    case "win32":
      return WINDOWS_CANDIDATES;
    case "darwin":
      return MAC_CANDIDATES;
    default:
      return LINUX_CANDIDATES;
  }
}

function firstExisting(candidates: FontCandidate[]): FontCandidate | null {
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) return candidate;
  }
  return null;
}

function toFontFile(candidate: FontCandidate): PdfFontFile {
  return candidate.family ? { path: candidate.path, family: candidate.family } : { path: candidate.path };
}

/**
 * 解析可用的中文字体。`env` 默认取 `process.env`，测试可注入。
 * 返回 `null` 表示没有任何可用字体，调用方应抛 `PDF_FONT_MISSING`。
 */
export function resolvePdfFonts(env: NodeJS.ProcessEnv = process.env): PdfFonts | null {
  const explicitPath = env.PDF_FONT_PATH?.trim();
  if (explicitPath && existsSync(explicitPath)) {
    const family = env.PDF_FONT_FAMILY?.trim();
    const file = toFontFile({ path: explicitPath, ...(family ? { family } : {}) });
    return { serif: file, sans: file, kai: file };
  }

  const candidates = candidatesForCurrentPlatform();
  const resolved: Partial<Record<PdfFontRole, FontCandidate>> = {};
  let firstAvailable: FontCandidate | null = null;
  const roles: PdfFontRole[] = ["serif", "sans", "kai"];

  for (const role of roles) {
    const found = firstExisting(candidates[role]);
    if (!found) continue;
    resolved[role] = found;
    firstAvailable ??= found;
  }

  if (!firstAvailable) return null;

  return {
    serif: toFontFile(resolved.serif ?? firstAvailable),
    sans: toFontFile(resolved.sans ?? firstAvailable),
    kai: toFontFile(resolved.kai ?? firstAvailable),
  };
}
