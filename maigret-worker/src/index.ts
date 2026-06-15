import { Container } from "@cloudflare/containers";

interface Env {
  MAIGRET_CONTAINER: DurableObjectNamespace & {
    getByName(name: string): Container;
  };
  LINK_SOCIAL_URL: string;
  INTERNAL_SECRET: string;
}

interface QueueMessage {
  user_id: string;
  username: string;
}

interface MaigretResult {
  ok: boolean;
  socials: Record<string, string>;
  status: string;
}

export class MaigretContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  enableInternet = true;
}

export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env) {
    for (const msg of batch.messages) {
      const { user_id, username } = msg.body;
      if (!user_id || !username) {
        msg.ack();
        continue;
      }

      try {
        const container = env.MAIGRET_CONTAINER.getByName("maigret-singleton");
        await container.startAndWaitForPorts();

        const response = await container.fetch("http://container/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user_id, username }),
        });

        if (!response.ok) {
          const text = await response.text();
          console.error(`Container error for @${username}: ${response.status} ${text}`);
          msg.retry();
          continue;
        }

        const result = await response.json() as MaigretResult & { error?: string };
        console.log(`Container result for @${username}: status=${result.status} socials=${JSON.stringify(result.socials)} error=${result.error}`);

        // Worker posts results to link-social (Worker has internet access always)
        const postRes = await fetch(`${env.LINK_SOCIAL_URL}/api/users/${user_id}/socials`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Secret": env.INTERNAL_SECRET,
          },
          body: JSON.stringify({ socials: result.socials, status: result.status }),
        });

        if (postRes.ok) {
          msg.ack();
          console.log(`Saved @${username}: ${result.status}, ${Object.keys(result.socials).length} platforms`);
        } else {
          console.error(`Failed to save @${username}: ${postRes.status} ${await postRes.text()}`);
          msg.retry();
        }
      } catch (err) {
        console.error(`Error for @${username}:`, err);
        msg.retry();
      }
    }
  },
};
