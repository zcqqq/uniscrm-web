// content/frontend/components/SkillUploadCard.tsx
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Label } from "../../../shared/frontend/ui/label";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { useT } from "../../../shared/frontend/hooks/useT";
import { api } from "../lib/api";
import { parseSkillFiles, unzipToEntries, type ParsedSkill } from "../lib/skill-package";

type Uploaded = { id: string; label: string; uploaded: boolean };

export function SkillUploadCard() {
  const T = useT();
  const { toast } = useToast();
  const [existing, setExisting] = useState<Uploaded[]>([]);
  const [preview, setPreview] = useState<ParsedSkill[]>([]);
  const [overwrite, setOverwrite] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const dirRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = () =>
    api.skills.list().then((r) => setExisting(r.skills.filter((s) => s.uploaded))).catch(() => {});
  useEffect(() => { reload(); }, []);

  // 重名只可能发生在上传的技能之间 —— 预置 id 是 marketingskills-*，上传是 upload:*。
  // 这只是前端的先手提醒：真正的判定（按 slug 后的 skillId）在后端，见下面 confirm 里的 409 分支。
  const existingLabels = new Set(existing.map((s) => s.label.toLowerCase()));
  const isConflict = (name: string) => existingLabels.has(name.toLowerCase());

  const ingest = async (files: File[]) => {
    try {
      const zip = files.find((f) => f.name.endsWith(".zip"));
      const entries = zip
        ? unzipToEntries(new Uint8Array(await zip.arrayBuffer()))
        : await Promise.all(
            files
              .filter((f) => f.name.endsWith(".md"))
              .map(async (f) => ({ path: (f as any).webkitRelativePath || f.name, text: await f.text() }))
          );
      setPreview(parseSkillFiles(entries));
      setOverwrite({});
    } catch (e) {
      toast({ title: T({ en: "Could not read that upload", zh: "这个上传读不出来" }), description: String(e), variant: "destructive" });
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const files: File[] = [];
    for (const item of Array.from(e.dataTransfer.items)) {
      const entry = (item as any).webkitGetAsEntry?.();
      if (entry?.isDirectory) files.push(...(await readDirectory(entry)));
      else if (item.kind === "file") { const f = item.getAsFile(); if (f) files.push(f); }
    }
    await ingest(files);
  };

  const rename = (index: number, name: string) =>
    setPreview((p) => p.map((s, i) => (i === index ? { ...s, name } : s)));

  const confirm = async () => {
    setBusy(true);
    try {
      await api.skills.import(
        preview.map((s) => ({ name: s.name, source: s.name, overwrite: !!overwrite[s.name], files: s.files }))
      );
      toast({ title: T({ en: "Skills imported", zh: "技能已导入" }) });
      setPreview([]);
      await reload();
    } catch (e: any) {
      // 后端自己也查重名（前端列表可能过期，或者是第二个标签页导入的）——409 时把提示摊开，
      // 让用户回到预览里勾选覆盖或改名，而不是被通用错误吞掉，无路可走。
      const msg = e?.status === 409
        ? T({ en: "Some names already exist — choose Overwrite or rename them.", zh: "有重名——请选择覆盖或改名。" })
        : T({ en: "Import failed", zh: "导入失败" });
      toast({ title: msg, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h2 className="text-sm font-semibold">{T({ en: "My skills", zh: "我的技能" })}</h2>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground"
      >
        {T({ en: "Drag & drop a .zip, a folder, or a SKILL.md", zh: "拖入 .zip、文件夹或 SKILL.md" })}
        <div className="mt-2 flex justify-center gap-2">
          <Button variant="ghost" onClick={() => fileRef.current?.click()}>
            {T({ en: "Choose file", zh: "选择文件" })}
          </Button>
          <Button variant="ghost" onClick={() => dirRef.current?.click()}>
            {T({ en: "Choose folder", zh: "选择文件夹" })}
          </Button>
        </div>
        <input ref={fileRef} type="file" accept=".zip,.md" className="hidden"
          onChange={(e) => ingest(Array.from(e.target.files ?? []))} />
        <input ref={dirRef} type="file" className="hidden"
          onChange={(e) => ingest(Array.from(e.target.files ?? []))}
          {...({ webkitdirectory: "", directory: "" } as any)} />
      </div>

      {preview.length > 0 && (
        <div className="space-y-2">
          {preview.map((s, i) => {
            const conflict = isConflict(s.name);
            return (
              <div key={i} className="flex items-center gap-2 text-sm">
                <Input value={s.name} onChange={(e: any) => rename(i, e.target.value)} className="flex-1 text-sm" />
                <span className="text-xs text-muted-foreground shrink-0">{Math.ceil(s.bytes / 1024)} KB</span>
                {conflict && (
                  <>
                    <span className="text-xs text-destructive shrink-0">{T({ en: "Name exists", zh: "已存在同名" })}</span>
                    <Button variant={overwrite[s.name] ? "default" : "ghost"} className="shrink-0"
                      onClick={() => setOverwrite((o) => ({ ...o, [s.name]: !o[s.name] }))}>
                      {T({ en: "Overwrite", zh: "覆盖" })}
                    </Button>
                    {/* 改名不是一个单独的按钮/接口——就是直接编辑左边那个 Input。这行只是提示用户
                        "改名也是条出路"，避免用户误以为除了覆盖别无选择。 */}
                    <span className="text-xs text-muted-foreground shrink-0">
                      {T({ en: "Rename", zh: "改名" })}
                    </span>
                  </>
                )}
              </div>
            );
          })}
          <div className="flex gap-2">
            <Button onClick={confirm} disabled={busy || preview.some((s) => isConflict(s.name) && !overwrite[s.name])}>
              {T({ en: "Import", zh: "导入" })}
            </Button>
            <Button variant="ghost" onClick={() => setPreview([])}>{T({ en: "Cancel", zh: "取消" })}</Button>
          </div>
        </div>
      )}

      {existing.length > 0 && (
        <div>
          <Label className="text-xs block mb-1">{T({ en: "Uploaded", zh: "已上传" })}</Label>
          {existing.map((s) => (
            <div key={s.id} className="flex items-center justify-between text-sm py-1">
              <span className="truncate">{s.label}</span>
              {/* 只有上传的技能能删；预置技能是所有租户共享的，这个卡片压根不列它们。 */}
              <Button variant="destructive" onClick={() => api.skills.remove(s.id).then(reload)}>
                {T({ en: "Delete", zh: "删除" })}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

async function readDirectory(entry: any): Promise<File[]> {
  const files: File[] = [];
  const reader = entry.createReader();
  const batch: any[] = await new Promise((res) => reader.readEntries(res));
  for (const e of batch) {
    if (e.isFile) files.push(await new Promise<File>((res) => e.file(res)));
    else if (e.isDirectory) files.push(...(await readDirectory(e)));
  }
  return files;
}
