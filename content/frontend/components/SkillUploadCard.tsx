// content/frontend/components/SkillUploadCard.tsx
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Label } from "../../../shared/frontend/ui/label";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { useT } from "../../../shared/frontend/hooks/useT";
import { api } from "../lib/api";
import { parseSkillFiles, unzipToEntries, SkillPackageError, type ParsedSkill } from "../lib/skill-package";

type Uploaded = { id: string; label: string; uploaded: boolean };

// name 是用户可编辑的字段（改名就是这个 Task 的"第二条出路"），不能拿它当 React state 的
// key —— 两行撞了同一个 name（比如两个技能文件夹的 frontmatter 都写 name: "Foo"）时，name
// 相同的行会共享同一个 overwrite 状态，点一行的"覆盖"会连带解锁另一行。rowId 在 ingest 时
// 一次性分配、之后永不随改名变化，专门用来给每一行钉住一个独立、稳定的 key。
type PreviewRow = ParsedSkill & { rowId: string };

export function SkillUploadCard() {
  const T = useT();
  const { toast } = useToast();
  const [existing, setExisting] = useState<Uploaded[]>([]);
  const [preview, setPreview] = useState<PreviewRow[]>([]);
  const [overwrite, setOverwrite] = useState<Record<string, boolean>>({});
  // 哪些行被判定为"重名"，按 rowId 记。两个来源：ingest 时对已上传列表的软提示（按 label
  // 比对，见下面 existingLabels），以及提交后 409 响应里精确点名的行（见 confirm()）。后者
  // 才是权威判定——不管前端的 label 猜测猜没猜对，都必须能亮起来。
  const [conflictedRowIds, setConflictedRowIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const dirRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextRowId = useRef(0);

  const reload = () =>
    api.skills.list().then((r) => setExisting(r.skills.filter((s) => s.uploaded))).catch(() => {});
  useEffect(() => { reload(); }, []);

  // 重名只可能发生在已上传的技能之间 —— 预置 id 是 marketingskills-*，上传是 upload:*。
  // 这只是 ingest 时的一次性软提示（按当前 name 大小写不敏感比对），真正的判定（按后端
  // slugify 后的 skillId）在服务端，见 confirm() 里的 409 分支——两者不是同一个等价关系
  // （"Foo Bar" 和 "foo_bar" 标签不同但 slug 相同），所以这里猜不中的情况完全正常，靠 409
  // 响应兜底，不靠反复重算这个软提示。
  const existingLabels = new Set(existing.map((s) => s.label.toLowerCase()));
  const isConflict = (row: PreviewRow) => conflictedRowIds.has(row.rowId);

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
      const rows: PreviewRow[] = parseSkillFiles(entries).map((s) => ({ ...s, rowId: `r${nextRowId.current++}` }));
      setPreview(rows);
      setOverwrite({});
      setConflictedRowIds(new Set(rows.filter((r) => existingLabels.has(r.name.toLowerCase())).map((r) => r.rowId)));
    } catch (e) {
      // parseSkillFiles/unzipToEntries 抛的是 SkillPackageError（双语）时用它自己的文案；
      // 别的失败（比如 zip 损坏）沿用原来的兜底：显示原始错误文本，读不出来但至少看得见原因。
      const description = e instanceof SkillPackageError ? T(e.copy) : String(e);
      toast({ title: T({ en: "Could not read that upload", zh: "这个上传读不出来" }), description, variant: "destructive" });
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    // DataTransfer 的数据存储只在事件同步派发期间可读：webkitGetAsEntry()/getAsFile() 必须
    // 在第一个 await 之前、对每一项都同步调用完——晚一拍再读，第二项开始就会静默拿到 null
    // （两个文件夹一起拖入时，第二个就是这么消失的）。grabDroppedEntries 是纯同步函数，
    // 专门把这条不变量钉死成结构，而不是靠注释提醒。
    const grabbed = grabDroppedEntries(Array.from(e.dataTransfer.items) as unknown as DropItem[]);
    try {
      const files: File[] = [];
      for (const { entry, file } of grabbed) {
        if (entry?.isDirectory) files.push(...(await readDirectory(entry)));
        else if (file) files.push(file);
      }
      await ingest(files);
    } catch (err) {
      // readDirectory 之前没接错误回调时，失败会让这个 await 永久 pending——用户既看不到
      // 导入结果也看不到任何提示。现在错误会真的 reject 上来，这里兜住给出 toast。
      toast({ title: T({ en: "Could not read that upload", zh: "这个上传读不出来" }), description: String(err), variant: "destructive" });
    }
  };

  const rename = (index: number, name: string) => {
    const rowId = preview[index]?.rowId;
    setPreview((p) => p.map((s, i) => (i === index ? { ...s, name } : s)));
    // 改名是"第二条出路"：一旦用户动手改了名字，之前对这一行的冲突判定就作废了——如果新
    // 名字还是撞，下一次提交的 409 响应会重新把它点出来；如果不撞了，Import 就该能点。
    if (rowId) {
      setConflictedRowIds((prev) => {
        if (!prev.has(rowId)) return prev;
        const next = new Set(prev);
        next.delete(rowId);
        return next;
      });
    }
  };

  const confirm = async () => {
    setBusy(true);
    // 提交时按当前的 name 精确记一份"name -> rowId"，供 409 响应回来时按 name 精确映射回
    // 是哪一行——不是重新实现后端的 slugify，就是原样匹配我们自己发出去的那个字符串。
    const rowIdByName = new Map(preview.map((s) => [s.name, s.rowId]));
    try {
      await api.skills.import(
        preview.map((s) => ({ name: s.name, source: s.name, overwrite: !!overwrite[s.rowId], files: s.files }))
      );
      toast({ title: T({ en: "Skills imported", zh: "技能已导入" }) });
      setPreview([]);
      setConflictedRowIds(new Set());
      await reload();
    } catch (e: any) {
      if (e?.status === 409) {
        // 后端自己也查重名（前端列表可能过期，或者是第二个标签页导入的）——409 时把提示摊开，
        // 让用户回到预览里勾选覆盖或改名，而不是被通用错误吞掉，无路可走。
        //
        // 冲突行不再靠"重新拉取列表 + 按 label 比对"去猜（那套猜法在 label 和 slug 分歧时
        // 永远猜不中：existing 是"Foo Bar"、这次提交的是"foo_bar"，label 比对怎么样都不会
        // 亮，Import 却因为没有一行被标红而一直可点，点了又是同一个 409，死循环）。改成直接
        // 吃响应体里 conflicts 携带的、我们自己提交时的原始 name，精确映射回 rowId——不管
        // label 认不认得出来，是哪一行提交出的这个 skillId，后端说了算。
        const conflicts: { skillId: string; name: string }[] = e.body?.conflicts ?? [];
        const rowIds = conflicts
          .map((c) => rowIdByName.get(c.name))
          .filter((id): id is string => !!id);
        if (rowIds.length > 0) {
          setConflictedRowIds((prev) => new Set([...prev, ...rowIds]));
        }
        // 仍然刷新一下已上传列表：不是为了让 isConflict 重新算（那已经不靠它了），单纯是
        // 另一个标签页/请求可能确实抢先创建了东西，界面该反映出来。
        await reload();
        toast({ title: T({ en: "Some names already exist — choose Overwrite or rename them.", zh: "有重名——请选择覆盖或改名。" }), variant: "destructive" });
      } else {
        // 之前一律显示"Import failed"，把服务端具体原因（emoji 名字没有可用字符、单个技能
        // 超过 256KB、批内两个名字撞了同一个 id……）吞掉了，用户/排障者两眼一抹黑。改成把
        // 服务端消息带上——它是英文原文（诊断信息，不是要求逐字翻译的静态界面文案），标题
        // 仍然双语。
        toast({
          title: T({ en: "Import failed", zh: "导入失败" }),
          description: e?.message || undefined,
          variant: "destructive",
        });
      }
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
            const conflict = isConflict(s);
            return (
              <div key={s.rowId} className="flex items-center gap-2 text-sm">
                <Input value={s.name} onChange={(e: any) => rename(i, e.target.value)} className="flex-1 text-sm" />
                <span className="text-xs text-muted-foreground shrink-0">{Math.ceil(s.bytes / 1024)} KB</span>
                {conflict && (
                  <>
                    <span className="text-xs text-destructive shrink-0">{T({ en: "Name exists", zh: "已存在同名" })}</span>
                    {/* rowId（不是 s.name）当 key：两行重名时各自独立的覆盖开关，点一行不会
                        连带解锁另一行——即使它俩眼下顶着同一个名字。 */}
                    <Button variant={overwrite[s.rowId] ? "default" : "ghost"} className="shrink-0"
                      onClick={() => setOverwrite((o) => ({ ...o, [s.rowId]: !o[s.rowId] }))}>
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
            <Button onClick={confirm} disabled={busy || preview.some((s) => isConflict(s) && !overwrite[s.rowId])}>
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

type DropItem = { kind: string; webkitGetAsEntry?: () => any; getAsFile: () => File | null };
type DropGrab = { entry: any; file: File | null };

// 把 DataTransferItemList 的每一项在同一个事件循环 tick 内、同步读完（entry 和/或 file）。
// 浏览器只在拖放事件同步派发期间允许读取 DataTransfer 的数据存储；这个函数本身不含任何
// await，靠这一点把"必须在第一个 await 之前完成读取"这条不变量做成结构上不可违反，而不是
// 靠调用方记得。
export function grabDroppedEntries(items: DropItem[]): DropGrab[] {
  return items.map((item) => ({
    entry: item.webkitGetAsEntry ? item.webkitGetAsEntry() : null,
    file: item.kind === "file" ? item.getAsFile() : null,
  }));
}

export async function readDirectory(entry: any): Promise<File[]> {
  const files: File[] = [];
  const reader = entry.createReader();
  // Chrome 的 readEntries 一次最多返回 100 条，必须反复调用直到收到空数组——只调一次会把
  // 目录里第 101 项之后的文件（可能是另一个技能的 SKILL.md，或者整个 references/ 目录）
  // 静默丢弃，预览看着仍然合理，用户完全没有信号。
  for (;;) {
    const batch: any[] = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) break;
    for (const e of batch) {
      if (e.isFile) files.push(await new Promise<File>((resolve, reject) => e.file(resolve, reject)));
      else if (e.isDirectory) files.push(...(await readDirectory(e)));
    }
  }
  return files;
}
