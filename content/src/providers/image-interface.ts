export interface ImageProvider {
  generate(prompt: string, model: string): Promise<{ bytes: ArrayBuffer; contentType: string }>;
}

export function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// 每个扩散模型对提示词长度都有硬上限，超了就是一个 4xx/5xx，而调用链上游会把它降级成
// "这条内容没有配图"、只留一行日志。截断在扩散模型上几乎零损失（它对提示词开头之外的
// 部分注意力很弱），所以宁可截也不要让请求撞墙。上限由各适配器提供 —— 它们是唯一知道
// 自己那个模型能吃多长的地方。
export function clampPrompt(prompt: string, maxChars: number): string {
  return prompt.length <= maxChars ? prompt : prompt.slice(0, maxChars);
}
