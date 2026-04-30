import type { CommerceChannelItem } from "./interface";

interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string | null;
  handle: string;
  updated_at: string;
}

interface ShopifyProductsResponse {
  products: ShopifyProduct[];
}

export function buildShopifyAuthUrl(
  shopDomain: string,
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const scopes = "read_products";
  return `https://${shopDomain}/admin/oauth/authorize?client_id=${clientId}&scope=${scopes}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
}

export async function exchangeShopifyCode(
  shopDomain: string,
  clientId: string,
  clientSecret: string,
  code: string
): Promise<{ access_token: string }> {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Shopify token exchange failed: ${err}`);
  }

  return res.json() as Promise<{ access_token: string }>;
}

export async function fetchShopifyProducts(
  shopDomain: string,
  accessToken: string
): Promise<CommerceChannelItem[]> {
  const res = await fetch(
    `https://${shopDomain}/admin/api/2024-01/products.json?fields=id,title,body_html,handle,updated_at&limit=250`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Shopify API error: ${res.status}`);
  }

  const data = (await res.json()) as ShopifyProductsResponse;

  return data.products.map((p) => ({
    channel_source_id: String(p.id),
    title: p.title,
    description: p.body_html ? stripHtml(p.body_html) : null,
    source_url: `https://${shopDomain}/products/${p.handle}`,
    source_modified_at: p.updated_at,
  }));
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}
