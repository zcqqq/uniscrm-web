import { XUnauthorizedError } from "./x-errors";

// Full set of tweet.fields the get-posts endpoint supports — requested in full so
// raw_data (see ContentService.upsertContentFromMetadata) captures everything X returns.
// https://docs.x.com/x-api/users/get-posts
const TWEET_FIELDS = [
  "id",
  "text",
  "author_id",
  "created_at",
  "conversation_id",
  "edit_controls",
  "edit_history_tweet_ids",
  "entities",
  "geo",
  "in_reply_to_user_id",
  "lang",
  "non_public_metrics",
  "note_tweet",
  "organic_metrics",
  "possibly_sensitive",
  "promoted_metrics",
  "public_metrics",
  "referenced_tweets",
  "reply_settings",
  "scopes",
  "source",
  "withheld",
].join(",");

export interface XPostsPage {
  data: Record<string, unknown>[];
  nextToken?: string;
}

export interface XPostsFetchResult {
  page: XPostsPage;
  rateLimited: boolean;
}

export async function fetchPostsPage(
  accessToken: string,
  xUserId: string,
  paginationToken?: string
): Promise<XPostsFetchResult> {
  const url = new URL(`https://api.x.com/2/users/${xUserId}/tweets`);
  url.searchParams.set("max_results", "100");
  url.searchParams.set("exclude", "replies,retweets");
  url.searchParams.set("tweet.fields", TWEET_FIELDS);
  if (paginationToken) url.searchParams.set("pagination_token", paginationToken);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 429) {
    return { page: { data: [] }, rateLimited: true };
  }
  if (res.status === 401) {
    throw new XUnauthorizedError(`X get-posts failed: ${res.status} ${await res.text()}`);
  }
  if (!res.ok) {
    throw new Error(`X get-posts failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { data?: Record<string, unknown>[]; meta?: { next_token?: string } };
  return { page: { data: body.data || [], nextToken: body.meta?.next_token }, rateLimited: false };
}

export interface CreatePostResult {
  ok: boolean;
  id?: string;
  rateLimited?: boolean;
}

export async function createPost(accessToken: string, text: string): Promise<CreatePostResult> {
  const res = await fetch("https://api.x.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (res.status === 429) {
    return { ok: false, rateLimited: true };
  }
  if (!res.ok) {
    return { ok: false };
  }

  const body = (await res.json()) as { data: { id: string; text: string } };
  return { ok: true, id: body.data.id };
}
