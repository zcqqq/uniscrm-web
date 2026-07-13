import { useState, useRef } from "react";
import { readMdFiles, type ParsedMd } from "../lib/markdown";
import { Button } from "../../../shared/frontend/ui/button";
import { ChannelCard } from "./ChannelCard";
import { LocalLogo } from "../lib/channelLogos";

interface Props {
  onImport: (files: ParsedMd[]) => Promise<boolean>;
}

export function LocalImport({ onImport }: Props) {
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
        name="Local"
        tagline={`${previewing.length} file${previewing.length === 1 ? "" : "s"} ready to import`}
        status="pending"
        extra={
          <div className="max-h-40 overflow-y-auto rounded-md border border-border">
            {previewing.map((f) => (
              <div key={f.filename} className="flex justify-between px-2 py-1.5 text-xs border-b border-border last:border-b-0">
                <span className="truncate">{f.title}</span>
                <span className="text-muted-foreground ml-2 shrink-0">
                  {f.fileModifiedAt ? new Date(f.fileModifiedAt).toLocaleDateString() : "—"}
                </span>
              </div>
            ))}
          </div>
        }
        actions={
          <div className="flex gap-2 w-full">
            <Button className="flex-1" onClick={handleConfirm} disabled={importing}>
              {importing ? "Importing..." : "Confirm Import"}
            </Button>
            <Button variant="outline" onClick={() => setPreviewing([])}>
              Cancel
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
        name="Local"
        tagline="Drag & drop .md files or a folder"
        status="connected"
        statusLabel="Ready"
        className={dragging ? "border-primary bg-primary/5" : "border-dashed"}
        actions={
          <Button variant="outline" className="w-full" onClick={() => inputRef.current?.click()}>
            Select Folder
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
