/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WEB_URL: string;
  readonly VITE_RECOMMENDATION_URL: string;
  readonly VITE_CONTENT_URL: string;
  readonly VITE_COMMERCE_URL: string;
  readonly VITE_SOCIAL_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
