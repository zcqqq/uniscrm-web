import { useState } from "react";
import { useSearchParams, Navigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "../../../shared/frontend/ui/card";
import { Separator } from "../../../shared/frontend/ui/separator";

export function Login() {
  const { login, member, loading } = useAuth();
  if (loading) return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  if (member) return <Navigate to="/" replace />;
  const [searchParams] = useSearchParams();
  const trial = searchParams.get("trial");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      await login(email, trial ?? undefined);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send");
    }
  };

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="text-xl">Check your email</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">
              We sent a sign-in link to <strong>{email}</strong>. Click it to sign in.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="max-w-md w-full">
        <CardHeader>
          <CardTitle>Sign in to UniSCRM</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {error && <p className="text-destructive text-sm">{error}</p>}

          <div className="space-y-3">
            <Button
              variant="outline"
              className="w-full justify-center gap-3"
              onClick={() => { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; const params = new URLSearchParams(); if (trial) params.set("trial", trial); params.set("timezone", tz); window.location.href = `/api/auth/google?${params}`; }}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Continue with Google
            </Button>
            <Button
              variant="outline"
              className="w-full justify-center gap-3"
              onClick={() => { const tz = Intl.DateTimeFormat().resolvedOptions().timeZone; const params = new URLSearchParams(); if (trial) params.set("trial", trial); params.set("timezone", tz); window.location.href = `/api/auth/x?${params}`; }}
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
              </svg>
              Continue with X
            </Button>
          </div>

          <div className="relative">
            <Separator />
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-4 text-sm text-muted-foreground">
              or sign in with email
            </span>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
            />
            <Button type="submit" className="w-full">
              Sign in with Email
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
