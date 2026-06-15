import type { FieldDefinition, ParsedConditions } from "../metadata";
import { generateFieldsPrompt } from "../metadata";

function buildSystemPrompt(fields: FieldDefinition[]): string {
  return `你是一个用户分群条件解析器。将自然语言描述转换为结构化JSON筛选条件。

可用字段（仅能使用以下字段）：
${generateFieldsPrompt(fields)}

输出格式（严格JSON，不要输出任何其他内容）：
{
  "logic": "AND" | "OR",
  "conditions": [
    {
      "field": "<prop_id>",
      "operator": "=" | "!=" | ">" | "<" | ">=" | "<=" | "IN" | "BETWEEN",
      "value": <值>,
      "timeRelative": "<数字>d"
    }
  ]
}

规则：
1. field 必须严格来自上面的可用字段列表
2. ENUM 类型只能用 = 或 != 或 IN，value 使用英文值（如 "blue" 而非 "蓝V"）
3. INT 类型可以用 >, <, >=, <=, =, !=, BETWEEN
4. DATETIME 字段表示"过去N天"时：operator用">="，value设为空字符串，timeRelative设为"<N>d"
5. 多个条件默认用 AND，除非用户明确说"或者"
6. 如果无法解析，返回 {"error": "无法解析条件描述"}`;
}

export interface ParseResult {
  success: true;
  conditions: ParsedConditions;
}

export interface ParseError {
  success: false;
  error: string;
}

export async function parseNaturalLanguage(
  ai: Ai,
  nlQuery: string,
  fields: FieldDefinition[]
): Promise<ParseResult | ParseError> {
  const systemPrompt = buildSystemPrompt(fields);

  const response = (await ai.run("@cf/meta/llama-3.1-8b-instruct" as Parameters<Ai["run"]>[0], {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: nlQuery },
    ],
    max_tokens: 512,
    temperature: 0,
  })) as { response?: string };

  const text = response.response || "";
  if (!text) {
    return { success: false, error: "LLM returned empty response" };
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { success: false, error: "LLM output is not valid JSON" };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.error) {
      return { success: false, error: parsed.error };
    }

    if (!parsed.logic || !Array.isArray(parsed.conditions)) {
      return { success: false, error: "Invalid structure: missing logic or conditions" };
    }

    return { success: true, conditions: parsed as ParsedConditions };
  } catch {
    return { success: false, error: "Failed to parse LLM JSON output" };
  }
}
