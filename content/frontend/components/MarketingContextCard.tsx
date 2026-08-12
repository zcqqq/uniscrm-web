// content/frontend/components/MarketingContextCard.tsx
import { useEffect, useState } from "react";
import { Button, buttonVariants } from "../../../shared/frontend/ui/button";
import { Label } from "../../../shared/frontend/ui/label";
import { Textarea } from "../../../shared/frontend/ui/textarea";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader,
  AlertDialogTitle, AlertDialogDescription, AlertDialogFooter,
  AlertDialogCancel, AlertDialogAction,
} from "../../../shared/frontend/ui/alert-dialog";
import { cn } from "../../../shared/frontend/lib/utils";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { useT } from "../../../shared/frontend/hooks/useT";
import { api } from "../lib/api";

type Msg = { role: "user" | "assistant"; content: string };
// 「帮我起草」「生成文档」都会用服务端响应整个覆盖编辑框；覆盖前要不要提醒用户，
// 取决于哪个待执行的动作——所以用 kind 记住"确认之后到底该跑哪一个"，而不是一个布尔量。
type PendingOverwrite = { kind: "draft" | "generate" } | null;

export function MarketingContextCard() {
  const T = useT();
  const { toast } = useToast();
  const [doc, setDoc] = useState<string>("");
  const [version, setVersion] = useState<number | null>(null);
  // 文档最近一次被"起草/生成/从服务端加载"覆盖时的内容。用户手改文本框会让 doc 偏离它，
  // 由此判断"是否存在还没保存的手改"——存在的话，「帮我起草」「生成文档」这两个会
  // 整体覆盖编辑框的动作在真正执行前要先问一句，否则用户刚打的字会被静默冲掉。
  // 保存成功后把它对齐到 doc：已经落库的内容不用再拿本地基线去防丢失。
  const [lastSyncedDoc, setLastSyncedDoc] = useState<string>("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingOverwrite, setPendingOverwrite] = useState<PendingOverwrite>(null);

  useEffect(() => {
    api.marketingContext.get()
      .then((r) => { setDoc(r.content ?? ""); setLastSyncedDoc(r.content ?? ""); setVersion(r.version); })
      .catch(() => {});
  }, []);

  const hasUnsavedEdits = doc !== lastSyncedDoc;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); }
    catch { toast({ title: T({ en: "Request failed", zh: "请求失败" }), variant: "destructive" }); }
    finally { setBusy(false); }
  };

  // 文档直接落进编辑框，不再落进对话区——对话区只留给真正的对话（提问、答复）。
  const runDraft = () => run(async () => {
    const { draft } = await api.marketingContext.draft();
    if (draft) {
      setDoc(draft);
      setLastSyncedDoc(draft);
    } else {
      // 没有任何信号可起草：这是一句要读的问句，不是文档内容，所以进对话区而不是编辑框。
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: T({
          en: "I could not find enough about you to draft from. Tell me what your product does and who it is for.",
          zh: "我这边还没有足够的信息可以起草。先告诉我你的产品是做什么的、给谁用？",
        }),
      }]);
    }
  });

  const handleSend = () => run(async () => {
    const next = [...messages, { role: "user" as const, content: input }];
    setMessages(next);
    setInput("");
    const { reply } = await api.marketingContext.chat(next);
    setMessages([...next, { role: "assistant", content: reply }]);
  });

  // 单独一次调用，响应体本身就是完整文档，直接覆盖编辑框——不需要哨兵、不需要解析
  // （详见设计文档 §8.4）。messages 允许为空：用户可能刚起草完/手改完就直接点这个按钮。
  //
  // 把编辑框当前内容（doc）一起发过去，让服务端拿它当"用户正看着的文档"：真实流程是
  // 「帮我起草」把草稿落进编辑框、聊几句、再点这个按钮——这份草稿从没被保存过，服务端
  // 自己去 D1 读只会读到空的或过期的旧版本，模型就看不见用户实际在编辑的内容。
  const runGenerate = () => run(async () => {
    const { document } = await api.marketingContext.generate(messages, doc);
    setDoc(document);
    setLastSyncedDoc(document);
  });

  // 起草/生成前若发现编辑框里有还没保存的手改，先弹确认——两个动作都会用服务端响应整体
  // 覆盖编辑框，不弹的话用户刚打的字就没了。
  //
  // 「帮我起草」的草稿完全来自租户近期内容 + 渠道清单，跟编辑框此刻写的什么无关，手改
  // 一定会被无声换掉——这个确认对它是必需的。「生成文档」现在会把编辑框当前内容当作
  // "用户当前的文档"发给模型（见 runGenerate），手改不再是对模型不可见的；但响应体仍会
  // 整体覆盖编辑框，而模型未必逐字保留用户的原始措辞，所以这里仍然保留确认——只是把
  // 弹窗文案换成了对两种情况都成立的说法，不再声称"从上一次保存的版本生成"（generate
  // 现在读的是编辑框，不是 D1 存档）。
  const requestOverwrite = (kind: "draft" | "generate") => {
    if (hasUnsavedEdits) { setPendingOverwrite({ kind }); return; }
    if (kind === "draft") runDraft(); else runGenerate();
  };
  const runPending = (kind: "draft" | "generate") => { if (kind === "draft") runDraft(); else runGenerate(); };

  // 不复用 run()：409（baseVersion 冲突）需要专门处理，不能被 run() 的通用 catch
  // 一律吞成"请求失败"——那样用户只会反复点、反复 409，没有任何走出去的路。
  // 返回是否保存成功，供"先保存再覆盖"这条链路判断要不要继续往下执行。
  const handleSave = async (content: string): Promise<boolean> => {
    setBusy(true);
    try {
      const { version: v } = await api.marketingContext.save(content, version ?? undefined);
      setDoc(content);
      setLastSyncedDoc(content);
      setVersion(v);
      toast({ title: T({ en: "Context saved", zh: "上下文已保存" }) });
      return true;
    } catch (err) {
      if ((err as { status?: number } | undefined)?.status === 409) {
        // 文档在别处被改过（另一个标签页、另一次对话）。只把本地 version 同步到最新，
        // 不覆盖用户还没提交的正文——覆盖了就是把用户刚打的字静默冲掉。version 对齐后，
        // 用户再点一次保存就能成功，不用刷新整个页面。
        toast({
          title: T({
            en: "This document changed elsewhere. Synced to the latest version — please save again.",
            zh: "这份文档在别处被修改过。已同步到最新版本——请重新点击保存。",
          }),
          variant: "destructive",
        });
        api.marketingContext.get().then((r) => setVersion(r.version)).catch(() => {});
      } else {
        toast({ title: T({ en: "Request failed", zh: "请求失败" }), variant: "destructive" });
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <h2 className="text-sm font-semibold">{T({ en: "Brand & product context", zh: "品牌与产品上下文" })}</h2>
      <p className="text-xs text-muted-foreground">
        {T({ en: "Used by every AI generation for this tenant. Version: ", zh: "本租户所有 AI 生成都会用到。版本：" })}
        {version ?? T({ en: "not set", zh: "未设置" })}
      </p>

      <div>
        <Label className="text-xs block mb-1">{T({ en: "Document (editable)", zh: "文档（可直接编辑）" })}</Label>
        <Textarea
          value={doc}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDoc(e.target.value)}
          rows={12}
          className="w-full text-sm font-mono"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => requestOverwrite("draft")} disabled={busy}>
          {T({ en: "Draft it for me", zh: "帮我起草" })}
        </Button>
        <Button variant="ghost" onClick={() => requestOverwrite("generate")} disabled={busy}>
          {T({ en: "Generate document", zh: "生成文档" })}
        </Button>
        {/* 保存的永远是当前编辑框里的内容，不管它是手改的、起草出来的还是生成出来的——
            这是唯一一条会真正写库的路径，其它按钮都只改本地 state。 */}
        <Button onClick={() => handleSave(doc)} disabled={busy || !doc.trim()}>
          {T({ en: "Save", zh: "保存" })}
        </Button>
      </div>

      <div className="space-y-2">
        <Label className="text-xs block">{T({ en: "Conversation", zh: "对话" })}</Label>
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {messages.map((m, i) => (
            <div key={i} className={m.role === "user" ? "text-sm text-right" : "text-sm"}>
              <span className="text-xs text-muted-foreground">
                {m.role === "user" ? T({ en: "You", zh: "你" }) : T({ en: "Assistant", zh: "助手" })}
              </span>
              <p className="whitespace-pre-wrap">{m.content}</p>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value)}
            rows={2}
            className="flex-1 text-sm"
            placeholder={T({ en: "Answer, or ask to change a section...", zh: "回答，或要求修改某一节…" })}
          />
          <Button onClick={handleSend} disabled={busy || !input.trim()}>{T({ en: "Send", zh: "发送" })}</Button>
        </div>
      </div>

      <AlertDialog open={pendingOverwrite !== null} onOpenChange={(open) => { if (!open) setPendingOverwrite(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{T({ en: "You have unsaved edits", zh: "有还没保存的修改" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {T({
                en: "This will replace the text in the box with a new version. Your current unsaved text won't necessarily be preserved as-is.",
                zh: "这会用新版本整体替换编辑框里的内容。你还没保存的文字不一定会被原样保留。",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{T({ en: "Cancel", zh: "取消" })}</AlertDialogCancel>
            <AlertDialogAction
              className={cn(buttonVariants({ variant: "outline" }))}
              onClick={() => { const kind = pendingOverwrite?.kind; setPendingOverwrite(null); if (kind) runPending(kind); }}
            >
              {T({ en: "Discard and continue", zh: "放弃修改并继续" })}
            </AlertDialogAction>
            <AlertDialogAction
              onClick={async () => {
                const kind = pendingOverwrite?.kind;
                setPendingOverwrite(null);
                // 只有真的存下去了才继续覆盖；409 等失败时手改还没落库，此时更不能接着覆盖。
                if (kind && await handleSave(doc)) runPending(kind);
              }}
            >
              {T({ en: "Save first, then continue", zh: "先保存，再继续" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
