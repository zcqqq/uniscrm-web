import { useState, useEffect } from "react";
import { api } from "../lib/api";
import { useAuth } from "../hooks/useAuth";
import { PasswordCard } from "../components/PasswordCard";
import { applyTheme, getTheme, type Theme } from "../../../shared/frontend/theme";
import { Card, CardHeader, CardTitle, CardContent } from "../../../shared/frontend/ui/card";
import { Select } from "../../../shared/frontend/ui/select";
import { Label } from "../../../shared/frontend/ui/label";
import { Button } from "../../../shared/frontend/ui/button";
import { Separator } from "../../../shared/frontend/ui/separator";
import { getTimezoneLabel, timezoneOptions } from "../lib/timezones";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";

export function Settings() {
  const { member, updateLocation, updateLanguage, updateTimezone } = useAuth();
  const T = useT();
  useEffect(() => { document.title = T({ en: "Settings — UniSCRM", zh: "设置 — UniSCRM" }); }, [T]);
  const [accounts, setAccounts] = useState<{ provider: string; created_at: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [theme, setThemeState] = useState<Theme>(getTheme());

  useEffect(() => {
    api.settings.getLinkedAccounts()
      .then((res) => setAccounts(res.accounts))
      .finally(() => setLoading(false));
  }, []);

  const handleUnlink = async (provider: string) => {
    await api.settings.unlinkAccount(provider);
    setAccounts((prev) => prev.filter((a) => a.provider !== provider));
  };

  const isLinked = (provider: string) => accounts.some((a) => a.provider === provider);

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-6">
      <h1 className="text-2xl font-bold text-foreground">{T({ en: "Settings", zh: "设置" })}</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{T({ en: "Appearance", zh: "外观" })}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            <Label>{T({ en: "Theme", zh: "主题" })}</Label>
            <Select
              value={theme}
              onChange={(e) => { const t = e.target.value as Theme; setThemeState(t); applyTheme(t); }}
            >
              <option value="system">{T({ en: "System", zh: "跟随系统" })}</option>
              <option value="light">{T({ en: "Light", zh: "浅色" })}</option>
              <option value="dark">{T({ en: "Dark", zh: "深色" })}</option>
            </Select>
          </div>

          <Separator />

          <div className="space-y-3">
            <Label>{T({ en: "Language", zh: "语言" })}</Label>
            <Select
              value={member?.language || "en"}
              onChange={async (e: React.ChangeEvent<HTMLSelectElement>) => {
                await updateLanguage(e.target.value);
                // 内联双语串由 useLocale 的 cookie 初值驱动，而 lang cookie 是后端在这次请求里写的。
                // 重新加载一次让整页拿到新语言——用一次刷新换掉整个 i18n 依赖库，划算。
                window.location.reload();
              }}
            >
              {/* i18n-ok: language picker shows each language's own native name (convention), not translated relative to current locale — matches "简体中文" below */}
              <option value="en">English</option>
              <option value="zh">简体中文</option>
            </Select>
          </div>

          <Separator />

          <div className="space-y-3">
            <Label>{T({ en: "Timezone", zh: "时区" })}</Label>
            <Select
              value={member?.timezone || "UTC"}
              onChange={(e) => updateTimezone(e.target.value)}
            >
              {timezoneOptions(member?.timezone).map((tz) => (
                <option key={tz} value={tz}>{getTimezoneLabel(tz)}</option>
              ))}
            </Select>
          </div>
        </CardContent>
      </Card>

      <PasswordCard />

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{T({ en: "Connected Accounts", zh: "已连接账号" })}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">{T(C.loading)}</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 border border-border rounded-md">
                <div className="flex items-center gap-3">
                  <svg className="w-5 h-5" viewBox="0 0 24 24">
                    {/* i18n-ok: SVG icon path data, not user-facing text */}
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                    {/* i18n-ok: SVG icon path data, not user-facing text */}
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                    {/* i18n-ok: SVG icon path data, not user-facing text */}
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                    {/* i18n-ok: SVG icon path data, not user-facing text */}
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
                  </svg>
                  {/* i18n-ok: third-party brand name, not translatable copy */}
                  <span className="font-medium text-foreground">Google</span>
                </div>
                {isLinked("google") ? (
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => handleUnlink("google")}>
                    {T({ en: "Disconnect", zh: "断开" })}
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => { window.location.href = "/api/auth/google?link=true"; }}>
                    {T({ en: "Connect", zh: "连接" })}
                  </Button>
                )}
              </div>

              <div className="flex items-center justify-between p-3 border border-border rounded-md">
                <div className="flex items-center gap-3">
                  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                    {/* i18n-ok: SVG icon path data, not user-facing text */}
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                  </svg>
                  {/* i18n-ok: third-party brand name, not translatable copy */}
                  <span className="font-medium text-foreground">X (Twitter)</span>
                </div>
                {isLinked("x") ? (
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => handleUnlink("x")}>
                    {T({ en: "Disconnect", zh: "断开" })}
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => { window.location.href = "/api/auth/x?link=true"; }}>
                    {T({ en: "Connect", zh: "连接" })}
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
