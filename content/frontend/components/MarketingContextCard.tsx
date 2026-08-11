// content/frontend/components/MarketingContextCard.tsx
import { useEffect, useState } from "react";
import { Button } from "../../../shared/frontend/ui/button";
import { Label } from "../../../shared/frontend/ui/label";
import { Textarea } from "../../../shared/frontend/ui/textarea";
import { useToast } from "../../../shared/frontend/hooks/use-toast";
import { useT } from "../../../shared/frontend/hooks/useT";
import { api } from "../lib/api";
import { extractContextBlock } from "../lib/context-block";

type Msg = { role: "user" | "assistant"; content: string };

export function MarketingContextCard() {
  const T = useT();
  const { toast } = useToast();
  const [doc, setDoc] = useState<string>("");
  const [version, setVersion] = useState<number | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.marketingContext.get()
      .then((r) => { setDoc(r.content ?? ""); setVersion(r.version); })
      .catch(() => {});
  }, []);

  // 只有解析出带哨兵的完整块才有可保存的文档。解析不出就没有按钮 —— 见 context-block.ts。
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const savableDoc = lastAssistant ? extractContextBlock(lastAssistant.content) : null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); }
    catch { toast({ title: T({ en: "Request failed", zh: "请求失败" }), variant: "destructive" }); }
    finally { setBusy(false); }
  };

  const handleDraft = () => run(async () => {
    const { draft } = await api.marketingContext.draft();
    setMessages([{
      role: "assistant",
      content: draft || T({ en: "I could not find enough about you to draft from. Tell me what your product does and who it is for.",
                            zh: "我这边还没有足够的信息可以起草。先告诉我你的产品是做什么的、给谁用？" }),
    }]);
  });

  const handleSend = () => run(async () => {
    const next = [...messages, { role: "user" as const, content: input }];
    setMessages(next);
    setInput("");
    const { reply } = await api.marketingContext.chat(next);
    setMessages([...next, { role: "assistant", content: reply }]);
  });

  // 不复用 run()：409（baseVersion 冲突）需要专门处理，不能被 run() 的通用 catch
  // 一律吞成"请求失败"——那样用户只会反复点、反复 409，没有任何走出去的路。
  const handleSave = async (content: string) => {
    setBusy(true);
    try {
      const { version: v } = await api.marketingContext.save(content, version ?? undefined);
      setDoc(content);
      setVersion(v);
      toast({ title: T({ en: "Context saved", zh: "上下文已保存" }) });
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

      {savableDoc && (
        <Button onClick={() => handleSave(savableDoc)} disabled={busy}>
          {T({ en: "Save this document", zh: "保存这份文档" })}
        </Button>
      )}

      <div className="flex gap-2">
        <Textarea
          value={input}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setInput(e.target.value)}
          rows={2}
          className="flex-1 text-sm"
          placeholder={T({ en: "Answer, or ask to change a section...", zh: "回答，或要求修改某一节…" })}
        />
        <Button onClick={handleSend} disabled={busy || !input.trim()}>{T({ en: "Send", zh: "发送" })}</Button>
        {messages.length === 0 && (
          <Button variant="ghost" onClick={handleDraft} disabled={busy}>
            {T({ en: "Draft it for me", zh: "帮我起草" })}
          </Button>
        )}
      </div>

      <div>
        <Label className="text-xs block mb-1">{T({ en: "Document (editable)", zh: "文档（可直接编辑）" })}</Label>
        <Textarea
          value={doc}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDoc(e.target.value)}
          rows={10}
          className="w-full text-sm font-mono"
        />
        {/* 独立的"保存编辑"按钮：用户手改 markdown 时明确点击才落库，不跟对话框那条自动路径混在一起。 */}
        <Button className="mt-2" variant="ghost" onClick={() => handleSave(doc)} disabled={busy || !doc.trim()}>
          {T({ en: "Save edits", zh: "保存编辑" })}
        </Button>
      </div>
    </div>
  );
}
