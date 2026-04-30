export interface ParsedMd {
  filename: string;
  title: string;
  summary: string;
  fileModifiedAt: string | null;
}

export function parseMdFile(file: File, text: string): ParsedMd {
  const headingMatch = text.match(/^#\s+(.+)$/m);
  const heading = headingMatch?.[1]?.trim();
  const title = heading ? `${file.name} — ${heading}` : file.name;

  const bodyText = text
    .replace(/^#.*$/gm, "")
    .replace(/[*_`~\[\]()>#+-]/g, "")
    .replace(/\n+/g, " ")
    .trim();
  const summary = bodyText.slice(0, 200);

  return {
    filename: file.name,
    title,
    summary,
    fileModifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
  };
}

export async function readMdFiles(files: File[]): Promise<ParsedMd[]> {
  const mdFiles = files.filter((f) => f.name.endsWith(".md"));
  const parsed = await Promise.all(
    mdFiles.map(async (file) => {
      const text = await file.text();
      return parseMdFile(file, text);
    })
  );
  return parsed.sort((a, b) => {
    if (!a.fileModifiedAt || !b.fileModifiedAt) return 0;
    return new Date(b.fileModifiedAt).getTime() - new Date(a.fileModifiedAt).getTime();
  });
}
