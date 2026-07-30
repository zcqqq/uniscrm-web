import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "../../../shared/frontend/ui/card";
import { Button } from "../../../shared/frontend/ui/button";
import { Input } from "../../../shared/frontend/ui/input";
import { Label } from "../../../shared/frontend/ui/label";

export function PasswordCard() {
  const { t } = useTranslation();
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
      setError(t("password.mismatch"));
      return;
    }
    setSaving(true);
    try {
      await api.settings.setPassword(next, hasPassword ? current : undefined);
      setHasPassword(true);
      setSaved(true);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("password.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">{t("password.loadError")}</p>
            <Button variant="outline" size="sm" onClick={fetchStatus}>{t("password.retry")}</Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {hasPassword === null ? t("password.loading") : hasPassword ? t("password.isSet") : t("password.notSet")}
          </p>
        )}
        {saved && <p className="text-sm text-primary">{t("password.saved")}</p>}

        {!open ? (
          <Button variant="outline" onClick={() => { setSaved(false); setOpen(true); }} disabled={hasPassword === null}>
            {hasPassword ? t("password.change") : t("password.set")}
          </Button>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            {hasPassword && (
              <div className="space-y-1.5">
                <Label>{t("password.current")}</Label>
                <Input
                  type="password"
                  value={current}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCurrent(e.target.value)}
                  required
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label>{t("password.new")}</Label>
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
              <Label>{t("password.confirm")}</Label>
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
              <Button type="submit" disabled={saving}>{t("password.save")}</Button>
              <Button type="button" variant="ghost" onClick={reset}>{t("password.cancel")}</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
