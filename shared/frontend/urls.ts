const isDev = typeof window !== "undefined" && window.location.hostname.includes("-dev");

export const URLS = {
  web: isDev ? "https://web-dev.uni-scrm.com" : "https://web.uni-scrm.com",
  link: isDev ? "https://link-dev.uni-scrm.com" : "https://link.uni-scrm.com",
  flow: isDev ? "https://flow-dev.uni-scrm.com" : "https://flow.uni-scrm.com",
  analytics: isDev ? "https://analytics-dev.uni-scrm.com" : "https://analytics.uni-scrm.com",
  segment: isDev ? "https://segment-dev.uni-scrm.com" : "https://segment.uni-scrm.com",
  content: isDev ? "https://content-dev.uni-scrm.com" : "https://content.uni-scrm.com",
};

// A module blanks its own base URL in the `urls` it hands the Sidebar (see the per-module Nav
// wrappers) so its menu hrefs stay same-origin relative. An item pointing at that module's root
// therefore arrives as "" — and an <a href=""> resolves to the *current* URL, silently reloading
// the page instead of navigating. Turn it back into the root path before rendering.
export const resolveHref = (href: string) => (href === "" ? "/" : href);
