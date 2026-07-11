export type PropDataType = "INT" | "TEXT" | "ENUM_INT" | "ENUM_TEXT" | "DATETIME";

export type LocalizedString = { en: string; zh: string };

export interface PropDefinition {
  propId: string;
  dataType: PropDataType;
  isInsight?: boolean;
  label: LocalizedString;
  enums?: { value: string | number; label: LocalizedString }[];
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