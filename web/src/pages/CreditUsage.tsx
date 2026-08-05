import { useEffect } from "react";
import { useCreditUsage } from "../hooks/useCreditUsage";
import { useAuth } from "../hooks/useAuth";
import { DateCell } from "../../../shared/frontend/components/CellDate";
import { formatDate } from "../../../shared/frontend/lib/format-time";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { Button } from "../../../shared/frontend/ui/button";
import { PageHeader } from "../../../shared/frontend/components/PageHeader";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../../shared/frontend/ui/table";
import { EventMetadata_X } from "../../../metadata/x";
import { formatUsd as formatUsdShared, microsToDollars } from "../../../shared/credit";
import { useT } from "../../../shared/frontend/hooks/useT";
import { C } from "../../../shared/frontend/i18n-common";
import { useLocale } from "../../../shared/frontend/hooks/useLocale";
import { t } from "../../../metadata/locale";
import type { Locale } from "../../../metadata/locale";

function actionLabel(eventType: string, locale: Locale): string {
  const meta = EventMetadata_X.find((m) => m.eventType === eventType);
  return meta ? t(meta.label, locale) : eventType;
}

function formatUsd(micros: number): string {
  return formatUsdShared(microsToDollars(micros));
}

export function CreditUsage() {
  const T = useT();
  const { locale } = useLocale();
  useEffect(() => { document.title = T({ en: "Credit Usage — UniSCRM", zh: "额度用量 — UniSCRM" }); }, [T]);
  const { usage, loading, page, setPage, pageSize } = useCreditUsage();
  const { member } = useAuth();
  const timezone = member?.timezone || "UTC";

  return (
    <div className="max-w-4xl mx-auto p-8">
      <PageHeader title={T({ en: "Credit Usage", zh: "额度用量" })} description={T({ en: "X action credit balance and usage history", zh: "X 动作额度余额与使用记录" })} />

      {loading && !usage ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : usage && usage.tier !== "basic" && usage.tier !== "pro" ? (
        <Card>
          <CardContent className="pt-6 text-muted-foreground">
            {T({ en: "Credit usage is only tracked for Basic and Pro plans.", zh: "额度用量仅在 Basic 与 Pro 套餐下记录。" })}
          </CardContent>
        </Card>
      ) : usage ? (
        <>
          <Card className="mb-6">
            <CardContent className="pt-6">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">{T({ en: "Remaining balance", zh: "剩余余额" })}</p>
                  <p className={`text-2xl font-bold ${usage.balanceMicros <= 0 ? "text-destructive" : "text-foreground"}`}>
                    {formatUsd(usage.balanceMicros)}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{T({ en: "Used this period", zh: "本期已用" })}</p>
                  <p className="text-2xl font-bold text-foreground">{formatUsd(usage.usedMicros)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{T({ en: "Monthly allowance", zh: "每月额度" })}</p>
                  <p className="text-2xl font-bold text-foreground">{formatUsd(usage.monthlyCreditMicros)}</p>
                </div>
              </div>
              {usage.periodStart && usage.periodEnd && (
                <p className="text-xs text-muted-foreground mt-4">
                  {T({ en: "Current period", zh: "当前周期" })}: {formatDate(usage.periodStart, timezone)} – {formatDate(usage.periodEnd, timezone)}
                </p>
              )}
              {usage.balanceMicros <= 0 && (
                <p className="text-sm text-destructive mt-2">
                  {T({ en: "Your credit balance is exhausted. X flow actions will fail until your next billing period, or upgrade your plan.", zh: "额度余额已耗尽，X 流程动作将失败，直到下个账单周期开始，或升级套餐。" })}
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{T(C.date)}</TableHead>
                    <TableHead>{T({ en: "Action", zh: "动作" })}</TableHead>
                    <TableHead>{T({ en: "Flow", zh: "流程" })}</TableHead>
                    <TableHead className="text-right">{T({ en: "Cost", zh: "费用" })}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.entries.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        {T({ en: "No credit usage yet.", zh: "暂无额度使用记录。" })}
                      </TableCell>
                    </TableRow>
                  ) : (
                    usage.entries.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="text-sm"><DateCell iso={e.created_at} timezone={timezone} /></TableCell>
                        <TableCell className="text-sm">{actionLabel(e.action_event_type, locale)}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{e.flow_id ?? "—"}</TableCell>
                        <TableCell className="text-sm text-right">{formatUsd(e.credit_micros)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>

              {usage.total > pageSize && (
                <div className="flex items-center justify-between mt-4">
                  <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                    {T({ en: "Previous", zh: "上一页" })}
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    {locale === "zh"
                      ? `第 ${page + 1} 页，共 ${Math.ceil(usage.total / pageSize)} 页`
                      : `Page ${page + 1} of ${Math.ceil(usage.total / pageSize)}`}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={(page + 1) * pageSize >= usage.total}
                    onClick={() => setPage(page + 1)}
                  >
                    {T({ en: "Next", zh: "下一页" })}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
