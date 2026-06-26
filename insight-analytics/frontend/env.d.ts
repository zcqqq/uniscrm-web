/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WEB_URL: string;
  readonly VITE_LINK_SOCIAL_URL: string;
  readonly VITE_PROFILE_URL: string;
  readonly VITE_INSIGHT_SEGMENT_URL: string;
  readonly VITE_INSIGHT_ANALYTICS_URL: string;
  readonly VITE_FLOW_URL: string;
  readonly VITE_CONTENT_URL: string;
  readonly VITE_COMMERCE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
