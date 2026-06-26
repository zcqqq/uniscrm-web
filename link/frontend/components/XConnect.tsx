import { useXChannel } from "../hooks/useXChannel";
import { Button } from "../../../shared/frontend/ui/button";
import { Card, CardContent } from "../../../shared/frontend/ui/card";

function XIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  );
}

export function XConnect() {
  const { connected, username, loading, connect, disconnect } = useXChannel();

  if (loading) {
    return (
      <Card className="animate-pulse">
        <CardContent className="p-6">
          <div className="h-4 bg-muted rounded w-24" />
        </CardContent>
      </Card>
    );
  }

  if (!connected) {
    return (
      <Card className="border-dashed border-2 border-border">
        <CardContent className="p-6 text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <XIcon />
            <span className="text-sm font-medium text-foreground">X</span>
          </div>
          <p className="text-muted-foreground text-sm mb-3">Connect to sync followers and receive events</p>
          <Button size="sm" onClick={connect}>
            Connect X
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
            <XIcon />
            <span className="text-sm font-medium text-foreground">X</span>
            {username && (
              <span className="text-xs text-muted-foreground">@{username}</span>
            )}
          </div>
          <Button variant="ghost" size="sm" className="text-destructive" onClick={disconnect}>
            Disconnect
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
