export type PropDataType = "INT" | "TEXT" | "ENUM_INT" | "ENUM_TEXT" | "DATETIME";

export type LocalizedString = { en: string; zh: string };

export interface PropDefinition {
  propId: string;
  dataType: PropDataType;
  isInsight?: boolean;
  // Which R2 snapshot table(s) this prop is a real column on. Drives which
  // props Content/User Analysis dimension & measure-field pickers offer —
  // keep in sync with link/src/services/x-users.ts's USER_TABLE_COLUMNS and
  // link/src/services/content.ts's CONTENT_COLUMN_MAP.
  entity?: Array<"user" | "content">;
  label: LocalizedString;
  enums?: { value: string | number; label: LocalizedString }[];
}

// propId 是这个 registry 里的主键，语义上不允许重复（下游按 propId 关联/upsert）。
// 用 const 类型参数保留数组字面量里每个 propId 的字符串字面量类型，递归比对；
// 一旦有重复，参数类型退化为一个提示重复值的模板字面量字符串，
// 数组字面量传进去会直接类型不匹配——在 x.ts 编辑处就能看到编译错误，不用等测试跑起来。
type DuplicatePropId<T extends readonly PropDefinition[], Seen extends string = never> =
  T extends readonly [infer Head extends PropDefinition, ...infer Rest extends readonly PropDefinition[]]
    ? Head["propId"] extends Seen
      ? Head["propId"]
      : DuplicatePropId<Rest, Seen | Head["propId"]>
    : never;

// 返回类型固定为 readonly PropDefinition[]（而不是推断出的 T），
// 否则消费方访问某个字面量元素没显式写的可选字段（如 isInsight/enums）时会报错——
// 那是字面量类型精确导致的噪音，不是真正的重复检测。
export function definePropDefinitions<const T extends readonly PropDefinition[]>(
  defs: DuplicatePropId<T> extends never ? T : `Duplicate propId: ${DuplicatePropId<T> & string}`
): readonly PropDefinition[] {
  return defs as unknown as readonly PropDefinition[];
}

export interface PropMapping {
  propId: string;
  dataId?: string;
  value?: string | number;
}

export interface UserMetadata {
  sourceUserType: string;
  linkPrefix?: string; //返回body嵌套太复杂时使用，少点代码
  userProps: PropMapping[];
}

export interface ContentMetadata {
  linkPrefix?: string; //返回body嵌套太复杂时使用，少点代码
  sourceContentType: string;
  contentProps: PropMapping[];
}

export interface EventMetadata {
  eventType: string;
  sourceEventType: string;
  linkPrefix?: string; //返回body嵌套太复杂时使用，少点代码
  flowType?: string; //trigger or action
  price?:number; //价格/官方费用
  label: LocalizedString;
  description?: LocalizedString;
  userProps: PropMapping[];
  userPropsFilter?: PropMapping[]; // action满足条件时才调用外部API
  eventProps: PropMapping[]; // link-social 存表时存所有字段到raw_data列，这里只控制flow模块
}