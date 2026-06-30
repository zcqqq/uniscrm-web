import { useTikTokChannel } from "../hooks/useTikTokChannel";
import { Button } from "../../../shared/frontend/ui/button";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";

function TikTokIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.88 2.89 2.89 0 01-2.88-2.88 2.89 2.89 0 012.88-2.88c.28 0 .54.04.79.1V9.4a6.33 6.33 0 00-.79-.05A6.34 6.34 0 003.15 15.7 6.34 6.34 0 009.49 22a6.34 6.34 0 006.34-6.34V9.04a8.16 8.16 0 004.77 1.52V7.11a4.85 4.85 0 01-1.01-.42z"/>
    </svg>
  );
}

export function TikTokConnect() {
  const { connected, displayName, loading, connect, disconnect } = useTikTokChannel();

  if (loading) {
    return (
      <Card className="p-6">
        <Skeleton className="h-4 w-24" />
      </Card>
    );
  }

  if (!connected) {
    return (
      <Card className="border-2 border-dashed">
        <CardContent className="p-6 text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <TikTokIcon />
            <span className="text-sm font-medium text-foreground">TikTok</span>
          </div>
          <p className="text-muted-foreground text-sm mb-3">Connect your TikTok account</p>
          <Button size="sm" onClick={connect}>
            Connect TikTok
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TikTokIcon />
            <span className="text-sm font-medium text-foreground">TikTok</span>
            {displayName && (
              <span className="text-xs text-muted-foreground">{displayName}</span>
            )}
          </div>
          <Button variant="link" size="sm" className="text-destructive" onClick={disconnect}>
            Disconnect
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
