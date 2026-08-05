import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { Card, CardHeader, CardTitle, CardContent } from "../../../shared/frontend/ui/card";
import { Input } from "../../../shared/frontend/ui/input";
import { Button } from "../../../shared/frontend/ui/button";
import { useT } from "../../../shared/frontend/hooks/useT";

export function CompleteProfile() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const T = useT();

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.auth.completeProfile(email);
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : T({ en: "Failed to send code", zh: "验证码发送失败" }));
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.auth.verifyCode(email, code);
      await refresh();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : T({ en: "Verification failed", zh: "验证失败" }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Card className="max-w-md w-full">
        <CardHeader>
          <CardTitle>{T({ en: "Complete your profile", zh: "完善你的资料" })}</CardTitle>
          <p className="text-muted-foreground text-sm">{T({ en: "We need your email to finish setting up your account.", zh: "需要你的邮箱来完成账号设置。" })}</p>
        </CardHeader>
        <CardContent>
          {error && <p className="text-destructive text-sm mb-4">{error}</p>}

          {step === "email" ? (
            <form onSubmit={handleSendCode} className="space-y-4">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={T({ en: "your@email.com", zh: "your@email.com" })}
                required
              />
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? T({ en: "Sending...", zh: "发送中…" }) : T({ en: "Send Verification Code", zh: "发送验证码" })}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleVerifyCode} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {T({ en: "We sent a 6-digit code to", zh: "验证码（6 位）已发送至" })} <strong className="text-foreground">{email}</strong>
              </p>
              <Input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={T({ en: "123456", zh: "123456" })}
                maxLength={6}
                required
                className="text-center text-2xl tracking-widest"
              />
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? T({ en: "Verifying...", zh: "验证中…" }) : T({ en: "Verify", zh: "验证" })}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
