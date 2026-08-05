import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { Card, CardHeader, CardTitle, CardContent } from "../../../shared/frontend/ui/card";
import { useT } from "../../../shared/frontend/hooks/useT";

// Language-independent error outcome, decided inside the effect. The effect must not depend on
// `T` (its identity changes when useLocale's fetched locale differs from the cookie-seeded
// initial value) — doing so re-fires the effect and calls api.auth.verify() a second time, which
// the backend rejects because the magic-link token is single-use. Translation happens only at
// render time, from this kind, never inside the effect.
type VerifyOutcome =
  | { kind: "missing-token" }
  | { kind: "verification-failed" }
  | { kind: "server-message"; message: string };

export function Verify() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState<VerifyOutcome | null>(null);
  const T = useT();

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setError({ kind: "missing-token" });
      return;
    }
    api.auth
      .verify(token)
      .then(() => refresh())
      .then(() => navigate("/", { replace: true }))
      .catch((err) =>
        setError(
          err instanceof Error
            ? { kind: "server-message", message: err.message }
            : { kind: "verification-failed" },
        ),
      );
  }, [searchParams, navigate, refresh]);

  if (error) {
    const message =
      error.kind === "missing-token"
        ? T({ en: "Missing token", zh: "缺少 Token" })
        : error.kind === "verification-failed"
        ? T({ en: "Verification failed", zh: "验证失败" })
        : error.message;

    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="text-xl text-destructive">
              {T({ en: "Verification Failed", zh: "验证失败" })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">{message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <p className="text-muted-foreground">{T({ en: "Verifying...", zh: "验证中…" })}</p>
    </div>
  );
}
