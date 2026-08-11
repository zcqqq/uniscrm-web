// content/frontend/lib/context-block.ts
//
// 哨兵字符串的唯一定义处在 shared/（后端 content/src/services/marketing-context.ts 也从这里
// import）——两侧各写一份字面量会悄悄失配，且失配时没有任何报错，只是保存按钮永远不出现。
import { CONTEXT_SENTINEL } from "../../../shared/marketing-context-sentinel";

export { CONTEXT_SENTINEL };

// 开栏行必须整行恰好是这个字符串（允许行尾空白），不能只是"以哨兵开头"——否则未来的
// PRODUCT-MARKETING-CONTEXT-V10 之类版本号也会被当成 V1 收掉。
const OPEN_LINE = "```" + CONTEXT_SENTINEL;

/**
 * 从一段助手回复里取出「以哨兵为 info string 且已完整闭合」的围栏块正文。
 *
 * 为什么不能用非贪婪正则一路扫到下一个 "```"：正文本身完全可能包含嵌套围栏（比如引用一段
 * 示例代码或示例贴文），非贪婪匹配会在遇到嵌套围栏的收口 "```" 时就误以为是外层块的收口，
 * 把后面本该属于正文的内容静默截断——Save 按钮照常出现，用户存下去的是一份被砍掉尾巴的文档，
 * 没有任何报错。
 *
 * 做法：按行扫描，用一个计数器跟踪"是否正处在嵌套围栏内"。嵌套围栏的开栏行（"```"后面
 * 紧跟别的字符，比如 "```js"）计数 +1；孤零零一整行只有三个反引号的行，如果当前在嵌套
 * 围栏里就计数 -1（嵌套围栏收口，仍属外层块正文），如果不在嵌套围栏里就是外层块真正的收口。
 *
 * 一条回复里出现两个哨兵块：只认第一个开栏行，且只有它被闭合才返回内容——聊天是增量对话，
 * 靠后再次出现的哨兵块更可能是模型在复述/纠错而不是又起草了一份新文档；即便第一个块没有
 * 闭合、后面那个闭合了，也不会退而取第二个——"哪个块生效"不该靠解析器去猜。
 */
export function extractContextBlock(text: string): string | null {
  const lines = text.split("\n");

  const openIdx = lines.findIndex((line) => line.trimEnd() === OPEN_LINE);
  if (openIdx === -1) return null;

  let nestedDepth = 0;
  const bodyLines: string[] = [];
  for (let i = openIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    if (trimmed === "```") {
      if (nestedDepth > 0) {
        // 收的是嵌套围栏，仍是外层块正文的一部分。
        nestedDepth--;
        bodyLines.push(line);
        continue;
      }
      // 外层块真正的收口。
      const body = bodyLines.join("\n").trim();
      return body ? body : null;
    }

    if (/^```\S/.test(trimmed)) nestedDepth++; // 嵌套围栏开栏，如 "```js"
    bodyLines.push(line);
  }

  // 扫到文末都没找到外层收口 —— 模型还没写完，不能给保存按钮。
  return null;
}
