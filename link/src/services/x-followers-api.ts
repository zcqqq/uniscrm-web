export interface XFollowersPage {
  data: Record<string, unknown>[];
  nextToken?: string;
}

export interface XFollowersFetchResult {
  page: XFollowersPage;
  rateLimited: boolean;
}

export async function fetchFollowersPage(
  accessToken: string,
  xUserId: string,
  paginationToken?: string
): Promise<XFollowersFetchResult> {
  const url = new URL(`https://api.x.com/2/users/${xUserId}/followers`);
  url.searchParams.set("max_results", "1000");
  url.searchParams.set("user.fields", "id,name,username");
  if (paginationToken) url.searchParams.set("pagination_token", paginationToken);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 429) {
    return { page: { data: [] }, rateLimited: true };
  }
  if (!res.ok) {
    throw new Error(`X get-followers failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { data?: Record<string, unknown>[]; meta?: { next_token?: string } };
  return { page: { data: body.data || [], nextToken: body.meta?.next_token }, rateLimited: false };
}
