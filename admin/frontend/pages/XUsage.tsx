import { useEffect, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Alert, AlertDescription, AlertTitle } from "../../../shared/frontend/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../../shared/frontend/ui/card";
import { Progress } from "../../../shared/frontend/ui/progress";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../../shared/frontend/ui/table";
import { Tabs, TabsList, TabsTrigger } from "../../../shared/frontend/ui/tabs";

interface UsageEntry {
  date: string;
  usage: number;
}

interface ClientAppUsage {
  client_app_id: string;
  usage_result_count: number;
  usage: UsageEntry[];
}

interface UsageData {
  cap_reset_day: number;
  project_cap: number;
  project_id: string;
  project_usage: number;
  daily_project_usage?: { project_id: number; usage: UsageEntry[] };
  daily_client_app_usage?: ClientAppUsage[];
}

interface ApiError {
  title: string;
  detail: string;
}

const DAY_OPTIONS = [7, 30, 90] as const;

function describeError(status: number, upstream?: number): ApiError {
  if (upstream === 401 || upstream === 403) {
    return {
      title: "X API 凭据无效",
      detail: "link worker 上的 X_BEARER_TOKEN 已失效或被轮换，需要重新 wrangler secret put。",
    };
  }
  if (upstream === 429) {
    return { title: "X API 限流", detail: "GET /2/usage/tweets 被限流，稍后再试。" };
  }
  if (status === 502) {
    return { title: "上游不可用", detail: `link worker 返回 ${upstream ?? "未知状态"}，检查 link 是否正常。` };
  }
  if (status === 403) {
    return { title: "无权访问", detail: "Access 会话可能已过期，刷新页面重新登录。" };
  }
  return { title: "请求失败", detail: `HTTP ${status}` };
}

async function fetchUsage(days: number): Promise<UsageData> {
  const res = await fetch(`/tms/api/x-usage?days=${days}`);
  if (!res.ok) {
    let upstream: number | undefined;
    try {
      upstream = ((await res.json()) as { upstream_status?: number }).upstream_status;
    } catch {
      upstream = undefined;
    }
    const e = describeError(res.status, upstream);
    throw Object.assign(new Error(e.title), e);
  }
  return ((await res.json()) as { data: UsageData }).data;
}

function formatDay(iso: string): string {
  return iso.slice(5, 10);
}

export function XUsage() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchUsage(days)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err: ApiError) => {
        if (!cancelled) {
          setData(null);
          setError({ title: err.title ?? "请求失败", detail: err.detail ?? String(err) });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const cap = Number(data?.project_cap ?? 0);
  const used = Number(data?.project_usage ?? 0);
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const trend = (data?.daily_project_usage?.usage ?? []).map((u) => ({
    day: formatDay(u.date),
    usage: Number(u.usage),
  }));
  const apps = (data?.daily_client_app_usage ?? []).map((a) => ({
    id: a.client_app_id,
    total: a.usage.reduce((sum, u) => sum + Number(u.usage), 0),
    dayCount: a.usage.length,
  }));

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl space-y-6 p-8">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">X API 平台用量</h1>
            <p className="text-sm text-muted-foreground">
              来自 X 的 GET /2/usage/tweets，整个 project 维度，非单租户
            </p>
          </div>
          <Tabs value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <TabsList>
              {DAY_OPTIONS.map((d) => (
                <TabsTrigger key={d} value={String(d)}>
                  {d} 天
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </header>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>{error.title}</AlertTitle>
            <AlertDescription>{error.detail}</AlertDescription>
          </Alert>
        )}

        {loading && <Skeleton className="h-40 w-full" />}

        {!loading && data && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>本周期用量</CardTitle>
                <CardDescription>
                  project {data.project_id} · 每月 {data.cap_reset_day} 日重置
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-baseline justify-between">
                  <span className="text-3xl font-semibold">{used.toLocaleString()}</span>
                  <span className="text-sm text-muted-foreground">
                    / {cap.toLocaleString()} ({pct.toFixed(1)}%)
                  </span>
                </div>
                <Progress value={pct} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>每日用量</CardTitle>
                <CardDescription>最近 {days} 天</CardDescription>
              </CardHeader>
              <CardContent>
                {trend.length === 0 ? (
                  <p className="text-sm text-muted-foreground">该区间内没有用量记录。</p>
                ) : (
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={trend}>
                        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" />
                        <XAxis dataKey="day" stroke="var(--color-muted-foreground)" fontSize={12} />
                        <YAxis stroke="var(--color-muted-foreground)" fontSize={12} />
                        <Tooltip
                          contentStyle={{
                            background: "var(--color-card)",
                            border: "1px solid var(--color-border)",
                            color: "var(--color-foreground)",
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="usage"
                          stroke="var(--color-primary)"
                          fill="var(--color-primary)"
                          fillOpacity={0.2}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>按 client app 分解</CardTitle>
                <CardDescription>同一 project 下各 app 在最近 {days} 天的合计</CardDescription>
              </CardHeader>
              <CardContent>
                {apps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">X 未返回 client app 明细。</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Client App ID</TableHead>
                        <TableHead className="text-right">合计用量</TableHead>
                        <TableHead className="text-right">有记录天数</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {apps.map((a) => (
                        <TableRow key={a.id}>
                          <TableCell className="font-mono text-xs">{a.id}</TableCell>
                          <TableCell className="text-right">{a.total.toLocaleString()}</TableCell>
                          <TableCell className="text-right">{a.dayCount}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
