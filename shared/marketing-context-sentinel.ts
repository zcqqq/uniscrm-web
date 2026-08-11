// 两侧都要认得同一个哨兵字符串：content/src（Worker 后端，把它塞进给模型的 prompt 里）与
// content/frontend（Vite 前端，靠它从助手回复里解析出可保存的文档）。分开各写一份字面量，
// 唯一约束它们相等的是注释——这正是"悄悄失配、保存按钮永远不出现、且没有任何报错"这条
// 故障模式的成因。这里是唯一定义处：纯字面量、零依赖（不 import D1/Env 之类的 Worker
// 类型），所以后端 Worker 和前端 bundle 都能直接 import，不会各自拖进不该有的依赖。
export const CONTEXT_SENTINEL = "PRODUCT-MARKETING-CONTEXT-V1";
