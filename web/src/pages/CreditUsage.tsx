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

function actionLabel(eventType: string): string {
  return EventMetadata_X.find((m) => m.eventType === eventType)?.label.en ?? eventType;
}

function formatUsd(micros: number): string {
  return formatUsdShared(microsToDollars(micros));
}

export function CreditUsage() {
  useEffect(() => { document.title = "Credit Usage — UniSCRM" }, []);
  const { usage, loading, page, setPage, pageSize } = useCreditUsage();
  const { member } = useAuth();
  const timezone = member?.timezone || "UTC";

  return (
    <div className="max-w-4xl mx-auto p-8">
      <PageHeader title="Credit Usage" description="X action credit balance and usage history" />

      {loading && !usage ? (
        <div className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : usage && usage.tier !== "basic" && usage.tier !== "pro" ? (
        <Card>
          <CardContent className="pt-6 text-muted-foreground">
            Credit usage is only tracked for Basic and Pro plans.
          </CardContent>
        </Card>
      ) : usage ? (
        <>
          <Card className="mb-6">
            <CardContent className="pt-6">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">Remaining balance</p>
                  <p className={`text-2xl font-bold ${usage.balanceMicros <= 0 ? "text-destructive" : "text-foreground"}`}>
                    {formatUsd(usage.balanceMicros)}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Used this period</p>
                  <p className="text-2xl font-bold text-foreground">{formatUsd(usage.usedMicros)}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">Monthly allowance</p>
                  <p className="text-2xl font-bold text-foreground">{formatUsd(usage.monthlyCreditMicros)}</p>
                </div>
              </div>
              {usage.periodStart && usage.periodEnd && (
                <p className="text-xs text-muted-foreground mt-4">
                  Current period: {formatDate(usage.periodStart, timezone)} – {formatDate(usage.periodEnd, timezone)}
                </p>
              )}
              {usage.balanceMicros <= 0 && (
                <p className="text-sm text-destructive mt-2">
                  Your credit balance is exhausted. X flow actions will fail until your next billing period, or upgrade your plan.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Flow</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.entries.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground">
                        No credit usage yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    usage.entries.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="text-sm"><DateCell iso={e.created_at} timezone={timezone} /></TableCell>
                        <TableCell className="text-sm">{actionLabel(e.action_event_type)}</TableCell>
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
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {page + 1} of {Math.ceil(usage.total / pageSize)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={(page + 1) * pageSize >= usage.total}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
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
