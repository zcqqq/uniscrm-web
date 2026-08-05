import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "../../../shared/frontend/ui/card";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Label } from "../../../shared/frontend/ui/label";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";

export function PasswordCard() {
  const T = useT();
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchStatus = () => {
    setLoadError(false);
    api.settings.get()
      .then((res) => setHasPassword(res.has_password))
      // A failed fetch must not masquerade as a known answer (e.g. "not set") — keep
      // hasPassword null so the toggle stays disabled, and surface a distinct retry state.
      .catch(() => setLoadError(true));
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const reset = () => {
    setOpen(false);
    setCurrent("");
    setNext("");
    setConfirm("");
    setError("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    // 两次输入一致这件事在本地判掉就行，没必要为它跑一趟网络
    if (next !== confirm) {
      setError(T({ en: "The two passwords do not match", zh: "两次输入的密码不一致" }));
      return;
    }
    setSaving(true);
    try {
      await api.settings.setPassword(next, hasPassword ? current : undefined);
      setHasPassword(true);
      setSaved(true);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : T({ en: "Failed to save", zh: "保存失败" }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{T({ en: "Password", zh: "密码" })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{T({ en: "Couldn't load password status. Please try again.", zh: "密码状态加载失败，请重试。" })}</p>
            <Button variant="outline" size="sm" onClick={fetchStatus}>{T(C.retry)}</Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {hasPassword === null
              ? T(C.loading)
              : hasPassword
              ? T({ en: "Password is set", zh: "已设置密码" })
              : T({ en: "Not set — you sign in with an email link or a connected account", zh: "未设置——你目前通过邮件登录链接或已连接的账号登录" })}
          </p>
        )}
        {saved && <p className="text-sm text-primary">{T({ en: "Password updated. Other devices have been signed out.", zh: "密码已更新，其它设备上的登录已被退出。" })}</p>}

        {!open ? (
          <Button variant="outline" onClick={() => { setSaved(false); setOpen(true); }} disabled={hasPassword === null}>
            {hasPassword ? T({ en: "Change password", zh: "修改密码" }) : T({ en: "Set password", zh: "设置密码" })}
          </Button>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            {hasPassword && (
              <div className="space-y-1.5">
                <Label>{T({ en: "Current password", zh: "当前密码" })}</Label>
                <Input
                  type="password"
                  value={current}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCurrent(e.target.value)}
                  required
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>{T({ en: "New password", zh: "新密码" })}</Label>
              <Input
                type="password"
                value={next}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNext(e.target.value)}
                minLength={8}
                maxLength={128}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>{T({ en: "Confirm new password", zh: "确认新密码" })}</Label>
              <Input
                type="password"
                value={confirm}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirm(e.target.value)}
                minLength={8}
                maxLength={128}
                required
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={saving}>{T(C.save)}</Button>
              <Button type="button" variant="ghost" onClick={reset}>{T(C.cancel)}</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
