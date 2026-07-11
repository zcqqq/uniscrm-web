// Full set of user.fields the get-followers endpoint supports — requested in full so
// raw_data (see XUsersService.upsertUserFromMetadata) captures everything X returns,
// not just the subset UserMetadata_X happens to map into structured columns.
// https://docs.x.com/x-api/users/get-followers
const USER_FIELDS = [
  "affiliation",
  "confirmed_email",
  "connection_status",
  "created_at",
  "description",
  "entities",
  "id",
  "is_identity_verified",
  "location",
  "most_recent_tweet_id",
  "name",
  "parody",
  "pinned_tweet_id",
  "profile_banner_url",
  "profile_image_url",
  "protected",
  "public_metrics",
  "receives_your_dm",
  "subscription",
  "subscription_type",
  "url",
  "username",
  "verified",
  "verified_followers_count",
  "verified_type",
  "withheld",
].join(",");

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
  url.searchParams.set("user.fields", USER_FIELDS);
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
