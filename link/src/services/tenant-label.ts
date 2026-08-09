// Identifying a tenant inside an error message that, by definition, a NON-member reads:
// the X account they are authorizing is already held by someone else's tenant. The bare
// numeric id is meaningless to a person and the owner email is another tenant's PII, so the
// label carries both, with the email's local part masked — enough for the very common case
// (it is the user's own second workspace) to be recognized, not enough to publish an address.
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1)}${"*".repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

// Never throws and never blocks the caller's own error path: a failed lookup degrades to the
// bare id rather than turning a clean 409 into a 500.
export async function describeTenant(webDb: D1Database | undefined, tenantId: number | null): Promise<string> {
  if (!tenantId) return "unassigned";
  try {
    const row = await webDb
      ?.prepare("SELECT email FROM tenants WHERE tenant_id = ?")
      .bind(tenantId)
      .first<{ email: string | null }>();
    const masked = maskEmail(row?.email);
    return masked ? `#${tenantId}, ${masked}` : `#${tenantId}`;
  } catch {
    return `#${tenantId}`;
  }
}
