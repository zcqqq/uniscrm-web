# Business
类似n8n的workflow编辑器，但更面相非技术人员。

# Code
使用React Flow框架
## Triggers
所有event trigger，默认在Event Props列表的第1位加上event_time

## Conditions

## Actions
调用第三方平台API（X API、TikTok API等）的action，默认支持success（绿色）failed（红色）两个后续分支。
调用内部服务（如profile worker）的action不特殊说明则仅有1个默认的后续分支。

# Technical
第三方API action的分支取决于HTTP响应：2xx→success，4xx/5xx/超时→failed。
Rate limit重试耗尽后才走failed分支（非首次429即失败）。