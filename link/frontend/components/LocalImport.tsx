import { useState, useRef } from "react";
import { readMdFiles, type ParsedMd } from "../lib/markdown";
import { Button } from "../../../shared/frontend/ui/button";
import { ChannelCard } from "./ChannelCard";
import { formatDate } from "../../../shared/frontend/lib/format-time";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";
import { LocalLogo } from "../lib/channelLogos";

interface Props {
  onImport: (files: ParsedMd[]) => Promise<boolean>; // i18n-ok: TypeScript type signature, not prose
}

export function LocalImport({ onImport }: Props) {
  const { timezone } = useLocale();
  const T = useT();
  const [previewing, setPreviewing] = useState<ParsedMd[]>([]);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: File[]) => {
    const parsed = await readMdFiles(files);
    setPreviewing(parsed);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files: File[] = [];
    for (const item of Array.from(e.dataTransfer.items)) {
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        const dirFiles = await readDirectory(entry as FileSystemDirectoryEntry);
        files.push(...dirFiles);
      } else if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    await handleFiles(files);
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    await handleFiles(files);
  };

  const handleConfirm = async () => {
    setImporting(true);
    try {
      const hadOverflow = await onImport(previewing);
      if (!hadOverflow) setPreviewing([]);
    } finally {
      setImporting(false);
    }
  };

  const hiddenInput = (
    <input
      ref={inputRef}
      type="file"
      className="hidden"
      onChange={handleFolderSelect}
      {...({ webkitdirectory: "", directory: "" } as any)}
    />
  );

  if (previewing.length > 0) {
    return (
      <ChannelCard
        logo={<LocalLogo />}
        name={T({ en: "Local", zh: "本地" })}
        tagline={T({
          en: `${previewing.length} file${previewing.length === 1 ? "" : "s"} ready to import`,
          zh: `共 ${previewing.length} 个文件待导入`,
        })}
        status="pending"
        extra={
          <div className="max-h-40 overflow-y-auto rounded-md border border-border">
            {previewing.map((f) => (
              <div key={f.filename} className="flex justify-between px-2 py-1.5 text-xs border-b border-border last:border-b-0">
                <span className="truncate">{f.title}</span>
                <span className="text-muted-foreground ml-2 shrink-0">
                  {f.fileModifiedAt ? formatDate(f.fileModifiedAt, timezone) : "—"}
                </span>
              </div>
            ))}
          </div>
        }
        actions={
          <div className="flex gap-2 w-full">
            <Button className="flex-1" onClick={handleConfirm} disabled={importing}>
              {importing ? T({ en: "Importing...", zh: "导入中…" }) : T({ en: "Confirm Import", zh: "确认导入" })}
            </Button>
            <Button variant="outline" onClick={() => setPreviewing([])}>
              {T(C.cancel)}
            </Button>
          </div>
        }
      />
    );
  }

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <ChannelCard
        logo={<LocalLogo />}
        name={T({ en: "Local", zh: "本地" })}
        tagline={T({ en: "Drag & drop .md files or a folder", zh: "拖拽 .md 文件或文件夹到此处" })}
        status="connected"
        statusLabel={T({ en: "Ready", zh: "就绪" })}
        className={dragging ? "border-primary bg-primary/5" : "border-dashed"}
        actions={
          <Button variant="outline" className="w-full" onClick={() => inputRef.current?.click()}>
            {T({ en: "Select Folder", zh: "选择文件夹" })}
          </Button>
        }
      />
      {hiddenInput}
    </div>
  );
}

async function readDirectory(entry: FileSystemDirectoryEntry): Promise<File[]> {
  const reader = entry.createReader();
  return new Promise((resolve) => {
    const files: File[] = [];
    reader.readEntries(async (entries) => {
      for (const e of entries) {
        if (e.isFile) {
          const file = await new Promise<File>((res) =>
            (e as FileSystemFileEntry).file(res)
          );
          files.push(file);
        }
      }
      resolve(files);
    });
  });
}
