import type { ChannelItem, ContentChannel } from "./interface";
import type { ChannelType } from "../types";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export class NotionChannel implements ContentChannel {
  type: ChannelType = "NOTION";

  constructor(private accessToken: string) {}

  requiresAuth(): boolean {
    return true;
  }

  async fetchItems(config: Record<string, unknown>): Promise<ChannelItem[]> {
    const folderIds = (config.folder_ids as string[]) ?? [];
    const items: ChannelItem[] = [];

    for (const folderId of folderIds) {
      const pages = await this.queryDatabase(folderId);
      items.push(...pages);
    }

    return items;
  }

  private async queryDatabase(databaseId: string): Promise<ChannelItem[]> {
    const items: ChannelItem[] = [];
    let hasMore = true;
    let startCursor: string | undefined;

    while (hasMore) {
      const body: Record<string, unknown> = {};
      if (startCursor) body.start_cursor = startCursor;

      const res = await fetch(`${NOTION_API}/databases/${databaseId}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Notion API error ${res.status}: ${err}`);
      }

      const data = (await res.json()) as {
        results: NotionPage[];
        has_more: boolean;
        next_cursor: string | null;
      };

      for (const page of data.results) {
        const title = extractTitle(page);
        if (!title) continue;

        items.push({
          source_content_id: page.id,
          title,
          summary: null,
          source_url: page.url,
          source_updated_at: page.last_edited_time,
        });
      }

      hasMore = data.has_more;
      startCursor = data.next_cursor ?? undefined;
    }

    return items;
  }

  static async listFolders(
    accessToken: string
  ): Promise<{ id: string; title: string }[]> {
    const res = await fetch(`${NOTION_API}/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: { value: "database", property: "object" },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Notion API error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as { results: NotionDatabase[] };

    return data.results.map((db) => ({
      id: db.id,
      title: db.title?.[0]?.plain_text ?? "Untitled",
    }));
  }
}

interface NotionPage {
  id: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, NotionProperty>;
}

interface NotionDatabase {
  id: string;
  title: { plain_text: string }[];
}

interface NotionProperty {
  type: string;
  title?: { plain_text: string }[];
}

function extractTitle(page: NotionPage): string | null {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title" && prop.title?.length) {
      return prop.title.map((t) => t.plain_text).join("");
    }
  }
  return null;
}
