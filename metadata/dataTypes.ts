export type PropDataType = "INT" | "TEXT" | "ENUM" | "DATETIME";

export type LocalizedString = { en: string; zh: string };

export interface PropDefinition {
  propId: string;
  dataType: PropDataType;
  label: LocalizedString;
  enums?: { value: string | number; label: LocalizedString }[];
}

export interface UserPropMapping {
  propId: string;
  dataId: string;
}

export interface EventPropMapping {
  propId: string;
  dataId: string;
}

export interface EventMetadata {
  eventType: string;
  originalEventType?: string;
  linkPrefix?: string;
  flowType?: string;
  label: LocalizedString;
  description?: LocalizedString;
  userProps: UserPropMapping[];
  eventProps: EventPropMapping[]; // link-social 存表时存所有字段到raw_data列，这里只控制flow模块
}
