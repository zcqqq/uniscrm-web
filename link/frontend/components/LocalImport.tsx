import { useState, useRef } from "react";
import { readMdFiles, type ParsedMd } from "../lib/markdown";
import { Button } from "../../../shared/frontend/ui/button";
import { Card, CardContent } from "../../../shared/frontend/ui/card";

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

  if (previewing.length > 0) {
    return (
      <Card>
        <CardContent className="p-4">
          <h3 className="font-semibold mb-3">Preview ({previewing.length} files)</h3>
          <div className="max-h-60 overflow-y-auto mb-4">
            {previewing.map((f) => (
              <div key={f.filename} className="flex justify-between py-1 text-sm border-b border-border">
                <span className="truncate">{f.title}</span>
                <span className="text-muted-foreground ml-2 shrink-0">
                  {f.fileModifiedAt ? new Date(f.fileModifiedAt).toLocaleDateString() : "—"}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button onClick={handleConfirm} disabled={importing}>
              {importing ? "Importing..." : "Confirm Import"}
            </Button>
            <Button variant="outline" onClick={() => setPreviewing([])}>
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card
      className={`border-2 border-dashed transition-colors ${
        dragging ? "border-primary bg-primary/5" : ""
      }`}
    >
      <CardContent
        className="p-6 text-center"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <div className="text-sm font-medium text-foreground mb-2">Local</div>
        <p className="text-muted-foreground text-sm mb-3">Drag & drop .md files or a folder</p>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={handleFolderSelect}
          {...({ webkitdirectory: "", directory: "" } as any)}
        />
        <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
          Select Folder
        </Button>
      </CardContent>
    </Card>
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
