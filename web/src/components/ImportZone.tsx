import { useState, useRef } from "react";
import { readMdFiles, type ParsedMd } from "../lib/markdown";

interface Props {
  onImport: (files: ParsedMd[]) => Promise<void>;
}

export function ImportZone({ onImport }: Props) {
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
      await onImport(previewing);
      setPreviewing([]);
    } finally {
      setImporting(false);
    }
  };

  if (previewing.length > 0) {
    return (
      <div className="border rounded-lg p-4 mb-6">
        <h3 className="font-semibold mb-3">Preview ({previewing.length} files)</h3>
        <div className="max-h-60 overflow-y-auto mb-4">
          {previewing.map((f) => (
            <div key={f.filename} className="flex justify-between py-1 text-sm border-b">
              <span className="truncate">{f.title}</span>
              <span className="text-gray-400 ml-2 shrink-0">
                {f.fileModifiedAt ? new Date(f.fileModifiedAt).toLocaleDateString() : "—"}
              </span>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <button onClick={handleConfirm} disabled={importing} className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50">
            {importing ? "Importing..." : "Confirm Import"}
          </button>
          <button onClick={() => setPreviewing([])} className="px-4 py-2 border rounded-md hover:bg-gray-50">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`border-2 border-dashed rounded-lg p-8 mb-6 text-center transition-colors ${dragging ? "border-blue-500 bg-blue-50" : "border-gray-300"}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <p className="text-gray-500 mb-3">Drag & drop .md files or a folder here</p>
      <input ref={inputRef} type="file" className="hidden" onChange={handleFolderSelect} {...{ webkitdirectory: "", directory: "" } as any} />
      <button onClick={() => inputRef.current?.click()} className="px-4 py-2 bg-white border rounded-md hover:bg-gray-50">
        Select Folder
      </button>
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
          const file = await new Promise<File>((res) => (e as FileSystemFileEntry).file(res));
          files.push(file);
        }
      }
      resolve(files);
    });
  });
}
