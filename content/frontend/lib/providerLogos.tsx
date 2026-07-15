// Small, distinctly-colored icon badges per provider. Deliberately not exact brand
// artwork (unverified from memory) -- lucide-react icons with a brand-ish accent
// color instead, same spirit as link/frontend/lib/channelLogos.tsx's one-icon-per-
// channel pattern.
import { Sparkles, Brain, Cloud } from "lucide-react";

export function OpenAiLogo() {
  return (
    <div className="w-full h-full flex items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
      <Sparkles className="w-5 h-5" aria-label="OpenAI" />
    </div>
  );
}

export function AnthropicLogo() {
  return (
    <div className="w-full h-full flex items-center justify-center rounded-xl bg-orange-500/10 text-orange-600">
      <Brain className="w-5 h-5" aria-label="Anthropic" />
    </div>
  );
}

export function WorkersAiLogo() {
  return (
    <div className="w-full h-full flex items-center justify-center rounded-xl bg-amber-500/10 text-amber-600">
      <Cloud className="w-5 h-5" aria-label="Cloudflare Workers AI" />
    </div>
  );
}
