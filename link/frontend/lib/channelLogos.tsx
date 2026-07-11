// Shared brand SVG logos for channel cards. Keep one icon per channel here so
// both the bespoke X cards and the generic simple-channel registry can reuse them.

export function XLogo() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor" aria-label="X">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  );
}

export function TikTokLogo() {
  return (
    <svg className="w-8 h-8" viewBox="0 0 24 24" fill="currentColor" aria-label="TikTok">
      <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.88 2.89 2.89 0 01-2.88-2.88 2.89 2.89 0 012.88-2.88c.28 0 .54.04.79.1V9.4a6.33 6.33 0 00-.79-.05A6.34 6.34 0 003.15 15.7 6.34 6.34 0 009.49 22a6.34 6.34 0 006.34-6.34V9.04a8.16 8.16 0 004.77 1.52V7.11a4.85 4.85 0 01-1.01-.42z"/>
    </svg>
  );
}
