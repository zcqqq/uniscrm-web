export async function signPayload(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sendWebhook(url: string, secret: string, payload: unknown): Promise<void> {
  if (!url) return;

  const body = JSON.stringify(payload);
  const signature = await signPayload(body, secret);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Signature": signature,
    },
    body,
  });

  if (!response.ok) {
    console.error(`Webhook delivery failed: ${response.status} ${response.statusText}`);
  }
}
