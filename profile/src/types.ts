interface ContainerInstance {
  startAndWaitForPorts(): Promise<void>;
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;
}

interface ContainerNamespace {
  getByName(name: string): ContainerInstance;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  WEB_URL: string;
  INTERNAL_SECRET: string;
  CF_ACCOUNT_ID: string;
  CF_D1_API_TOKEN: string;
  MAIGRET_CONTAINER: ContainerNamespace;
}
