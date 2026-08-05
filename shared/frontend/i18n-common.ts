import type { LocalizedString } from "../../metadata/dataTypes";

// 全站高频词的统一译法。准入线：一个词在 3 个以上模块出现才收进来——
// 页面专属文案一律内联在使用处，否则这里会膨胀成第二个字典，
// 而「文案与使用处分离」正是这次要消灭的东西。
export const C = {
  save: { en: "Save", zh: "保存" },
  cancel: { en: "Cancel", zh: "取消" },
  delete: { en: "Delete", zh: "删除" },
  edit: { en: "Edit", zh: "编辑" },
  add: { en: "Add", zh: "添加" },
  create: { en: "Create", zh: "新建" },
  confirm: { en: "Confirm", zh: "确认" },
  close: { en: "Close", zh: "关闭" },
  back: { en: "Back", zh: "返回" },
  next: { en: "Next", zh: "下一步" },
  search: { en: "Search", zh: "搜索" },
  loading: { en: "Loading…", zh: "加载中…" },
  retry: { en: "Retry", zh: "重试" },
  refresh: { en: "Refresh", zh: "刷新" },
  copy: { en: "Copy", zh: "复制" },
  export: { en: "Export", zh: "导出" },
  name: { en: "Name", zh: "名称" },
  status: { en: "Status", zh: "状态" },
  actions: { en: "Actions", zh: "操作" },
  type: { en: "Type", zh: "类型" },
  date: { en: "Date", zh: "日期" },
  description: { en: "Description", zh: "说明" },
  enabled: { en: "Enabled", zh: "已启用" },
  disabled: { en: "Disabled", zh: "已停用" },
  yes: { en: "Yes", zh: "是" },
  no: { en: "No", zh: "否" },
  none: { en: "None", zh: "无" },
  all: { en: "All", zh: "全部" },
  error: { en: "Error", zh: "错误" },
  settings: { en: "Settings", zh: "设置" },
} satisfies Record<string, LocalizedString>;
