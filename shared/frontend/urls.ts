const isDev = typeof window !== "undefined" && window.location.hostname.includes("-dev");

export const URLS = {
  web: isDev ? "https://web-dev.uni-scrm.com" : "https://web.uni-scrm.com",
  link: isDev ? "https://link-dev.uni-scrm.com" : "https://link.uni-scrm.com",
  flow: isDev ? "https://flow-dev.uni-scrm.com" : "https://flow.uni-scrm.com",
  analytics: isDev ? "https://analytics-dev.uni-scrm.com" : "https://analytics.uni-scrm.com",
  segment: isDev ? "https://segment-dev.uni-scrm.com" : "https://segment.uni-scrm.com",
  content: isDev ? "https://content-dev.uni-scrm.com" : "https://content.uni-scrm.com",
};
