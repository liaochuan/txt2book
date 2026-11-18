import type { BookMeta } from "../../../types/book";
import { escapeXml } from "./xhtml";

export interface OpfManifestItem {
  id: string;
  href: string;
  mediaType: string;
  /** 如 `nav`、`cover-image`。 */
  properties?: string;
}

export interface OpfSpineItem {
  idref: string;
  /** `false` 时写入 `linear="no"`（如被关闭的目录页）。 */
  linear?: boolean;
}

export interface OpfAssets {
  /** 形如 `urn:uuid:...`。 */
  identifier: string;
  /** ISO 8601 UTC，写入 `dcterms:modified`。 */
  modified: string;
  /** 封面图片在 manifest 中的 id，用于 `<meta name="cover">`。 */
  coverImageId?: string;
  /** NCX 在 manifest 中的 id，用于 `<spine toc="...">`。 */
  ncxId?: string;
  /**
   * 额外的图片 manifest 项（如自定义背景）。
   * 追加在调用方给定的 manifest 之后，不改变封面等既有条目的相对顺序。
   */
  images?: OpfManifestItem[];
}

const NCX_MEDIA_TYPE = "application/x-dtbncx+xml";

/** `META-INF/container.xml` 固定内容：入口指向 `OEBPS/content.opf`。 */
export const containerXml = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

/**
 * 生成 `content.opf`。`manifest` 与 `spine` 由调用方按最终顺序给定，
 * 这里只负责序列化、转义与 EPUB 3 元数据。
 */
export function buildOpf(
  meta: BookMeta,
  manifest: OpfManifestItem[],
  spine: OpfSpineItem[],
  assets: OpfAssets,
): string {
  const title = meta.title.trim() || "未命名";
  const author = meta.author.trim();
  const description = (meta.description ?? "").trim();

  const metadata: string[] = [
    `    <dc:identifier id="bookid">${escapeXml(assets.identifier)}</dc:identifier>`,
    `    <dc:title>${escapeXml(title)}</dc:title>`,
    ...(author ? [`    <dc:creator>${escapeXml(author)}</dc:creator>`] : []),
    `    <dc:language>${escapeXml(meta.language)}</dc:language>`,
    ...(description ? [`    <dc:description>${escapeXml(description)}</dc:description>`] : []),
    `    <meta property="dcterms:modified">${escapeXml(assets.modified)}</meta>`,
    ...(assets.coverImageId ? [`    <meta name="cover" content="${escapeXml(assets.coverImageId)}"/>`] : []),
  ];

  const manifestEntries = [...manifest, ...(assets.images ?? [])].map((item) => {
    const properties = item.properties ? ` properties="${escapeXml(item.properties)}"` : "";
    return `    <item id="${escapeXml(item.id)}" href="${escapeXml(item.href)}" media-type="${escapeXml(item.mediaType)}"${properties}/>`;
  });

  const spineEntries = spine.map((item) => {
    const linear = item.linear === false ? ' linear="no"' : "";
    return `    <itemref idref="${escapeXml(item.idref)}"${linear}/>`;
  });

  const spineToc = assets.ncxId ? ` toc="${escapeXml(assets.ncxId)}"` : "";

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="' +
      escapeXml(meta.language) +
      '">',
    '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">',
    ...metadata,
    "  </metadata>",
    "  <manifest>",
    ...manifestEntries,
    "  </manifest>",
    `  <spine${spineToc}>`,
    ...spineEntries,
    "  </spine>",
    "</package>",
    "",
  ].join("\n");
}

/** NCX 的 media-type，供调用方构造 manifest 时使用。 */
export { NCX_MEDIA_TYPE };
