import { createInternalAuthMiddleware } from "../../../shared/auth";

// Delegates to the shared fail-closed implementation (shared/auth.ts); admin's historical
// 401 {"error":"Unauthorized"} shape is the shared default.
export const internalAuth = createInternalAuthMiddleware();
