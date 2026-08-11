// 与后端 CONTEXT_SENTINEL 保持一致（content/src/services/marketing-context.ts）。
export const CONTEXT_SENTINEL = "PRODUCT-MARKETING-CONTEXT-V1";

// 只认「以哨兵为 info string 且已闭合」的围栏块。未闭合 = 模型还没写完，
// 这时给出保存按钮就会把半份文档灌进此后所有生成 —— 宁可让用户多聊一轮。
const BLOCK_RE = new RegExp("```" + CONTEXT_SENTINEL + "\\s*\\n([\\s\\S]*?)\\n```");

export function extractContextBlock(text: string): string | null {
  const m = text.match(BLOCK_RE);
  const body = m?.[1]?.trim();
  return body ? body : null;
}
