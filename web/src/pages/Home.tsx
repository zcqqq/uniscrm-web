import { useRecommendations } from "../hooks/useRecommendations";
import { useAuth } from "../hooks/useAuth";
import { Badge } from "../../../shared/frontend/ui/badge";
import { Select } from "../../../shared/frontend/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../../shared/frontend/ui/table";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { PageHeader } from "../../../shared/frontend/components/PageHeader";
import { EmptyState } from "../../../shared/frontend/components/EmptyState";
import { useT } from "../../../shared/frontend/hooks/useT";

function ScoreBadge({ score }: { score: number }) {
  return (
    <Badge variant="secondary" className="font-mono">
      {(score * 100).toFixed(0)}%
    </Badge>
  );
}

export function Home() {
  const { member, updateLocation } = useAuth();
  const { recommendations, loading } = useRecommendations();
  const T = useT();

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto p-8 space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (recommendations.length === 0) {
    return (
      <div className="max-w-5xl mx-auto p-8">
        <PageHeader title={T({ en: "Recommendations", zh: "推荐" })} />
        <EmptyState
          title={T({ en: "No recommendations yet", zh: "暂无推荐" })}
          description={T({ en: "Import content and products, then wait for trend matching.", zh: "导入内容和商品后，等待趋势匹配。" })}
        />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-8">
      <PageHeader
        title={T({ en: "Top Recommendations", zh: "热门推荐" })}
        actions={
          <Select
            value={member?.preferred_location}
            onChange={(e) => updateLocation(e.target.value)}
            className="text-sm"
          >
            <option value="global">{T({ en: "Global", zh: "全球" })}</option>
            <option value="china">{T({ en: "China", zh: "中国" })}</option>
          </Select>
        }
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-1/3">{T({ en: "Trend", zh: "趋势" })}</TableHead>
            <TableHead className="w-1/3">{T({ en: "Content", zh: "内容" })}</TableHead>
            <TableHead className="w-1/3">{T({ en: "Product", zh: "商品" })}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recommendations.map((group, i) => (
            <TableRow key={i}>
              <TableCell>
                {group.trend ? (
                  <div>
                    <div className="font-medium">{group.trend.title}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground/60">{group.trend.platform}</span>
                      {group.trend.similarity < 1 && <ScoreBadge score={group.trend.similarity} />}
                    </div>
                  </div>
                ) : (
                  <span className="text-muted-foreground/40">{"—"}</span>
                )}
              </TableCell>
              <TableCell>
                {group.content ? (
                  <div>
                    <div className="font-medium truncate max-w-xs">{group.content.title}</div>
                    <ScoreBadge score={group.content.similarity} />
                  </div>
                ) : (
                  <span className="text-muted-foreground/40">{"—"}</span>
                )}
              </TableCell>
              <TableCell>
                {group.product ? (
                  <div>
                    <div className="font-medium truncate max-w-xs">{group.product.title}</div>
                    <ScoreBadge score={group.product.similarity} />
                  </div>
                ) : (
                  <span className="text-muted-foreground/40">{"—"}</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
