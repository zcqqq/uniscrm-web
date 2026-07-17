import { useRef, useState } from "react";
import { findInvalidNodeType } from "../lib/validate-generated-graph";

interface AiGenerateBarProps {
  endpoint: string;
  context?: any;
  placeholder?: string;
  onResult: (json: any) => void;
  extraBody?: Record<string, unknown>;
  allowedNodeTypes?: string[];
}

export default function AiGenerateBar({ endpoint, context, placeholder = "Describe...", onResult, extraBody, allowedNodeTypes }: AiGenerateBarProps) {
  const [prompt, setPrompt] = useState("");
  const [log, setLog] = useState("");
  const [generating, setGenerating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleGenerate = async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setExpanded(true);
    setLog("");
    const input = prompt;
    setPrompt("");

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: input, currentContext: context, ...extraBody }),
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        setLog((err as any).error || "Generation failed");
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ") && line !== "data: [DONE]") {
            try {
              const json = JSON.parse(line.slice(6));
              const token = json.response || "";
              full += token;
              setLog(full);
              if (textareaRef.current) {
                textareaRef.current.scrollTop = textareaRef.current.scrollHeight;
              }
            } catch {}
          }
        }
      }

      const nodesIdx = full.indexOf('"nodes"') !== -1 ? full.indexOf('"nodes"') : full.indexOf('\\"nodes\\"');
      if (nodesIdx !== -1) {
        const firstBrace = full.lastIndexOf("{", nodesIdx);
        const lastBrace = full.lastIndexOf("}");
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          let jsonStr = full.slice(firstBrace, lastBrace + 1);
          if (jsonStr.includes('\\"')) jsonStr = jsonStr.replace(/\\"/g, '"');
          try {
            const parsed = JSON.parse(jsonStr);
            const invalidType = allowedNodeTypes ? findInvalidNodeType(parsed.nodes, allowedNodeTypes) : null;
            if (invalidType !== null) {
              setLog(full + `\n\n[Generated an invalid node type "${invalidType}" for this flow — please try again]`);
              return;
            }
            onResult(parsed);
          } catch {
            setLog(full + "\n\n[Failed to parse JSON from response]");
          }
        }
      }
    } catch (e: any) {
      setLog(e.message || "Generation failed");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <>
      <div className="relative flex-1 mx-2 h-7">
        <textarea
          ref={textareaRef}
          value={generating || log ? log : prompt}
          onChange={(e) => { if (!generating) { setLog(""); setPrompt(e.target.value); } }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !generating) { e.preventDefault(); handleGenerate(); } }}
          onFocus={() => setExpanded(true)}
          onBlur={() => { if (!generating) setExpanded(false); }}
          readOnly={generating}
          placeholder={placeholder}
          className={`absolute top-0 left-0 w-full text-sm border border-border rounded px-2 py-1 bg-background outline-none focus:border-primary resize-none z-10 ${
            expanded || generating ? "h-32 overflow-y-auto" : "h-7 overflow-hidden whitespace-nowrap"
          }`}
          rows={1}
        />
      </div>
      <button
        onClick={handleGenerate}
        disabled={generating || (!prompt.trim() && !log)}
        className="px-2 py-1 text-xs bg-primary text-primary-foreground rounded font-medium hover:bg-primary/90 disabled:opacity-50 whitespace-nowrap shrink-0"
      >
        {generating ? "..." : "Generate"}
      </button>
    </>
  );
}
