// MultiSelect 触发按钮上的已选摘要。独立成纯函数文件：测试环境是 workerd（无 DOM），
// 组件本体没法单测，把可测的决策逻辑放在这里。
export function multiSelectSummary(selectedLabels: string[], placeholder: string): string {
  if (selectedLabels.length === 0) return placeholder;
  if (selectedLabels.length === 1) return selectedLabels[0];
  return `${selectedLabels[0]} +${selectedLabels.length - 1} more`;
}
