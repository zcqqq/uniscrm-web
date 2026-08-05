import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { Card, CardHeader, CardTitle, CardContent } from "../../../shared/frontend/ui/card";
import { useT } from "../../../shared/frontend/hooks/useT";

export function Verify() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [error, setError] = useState("");
  const T = useT();

  useEffect(() => {
    const token = searchParams.get("token");
    if (!token) {
      setError(T({ en: "Missing token", zh: "缺少 Token" }));
      return;
    }
    api.auth
      .verify(token)
      .then(() => refresh())
      .then(() => navigate("/", { replace: true }))
      .catch((err) =>
        setError(err instanceof Error ? err.message : T({ en: "Verification failed", zh: "验证失败" })),
      );
  }, [searchParams, navigate, refresh, T]);

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle className="text-xl text-destructive">
              {T({ en: "Verification Failed", zh: "验证失败" })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">{error}</p>
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
