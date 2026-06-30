import { useRecommendations } from "../hooks/useRecommendations";
import { useAuth } from "../hooks/useAuth";
import { Badge } from "../../../shared/frontend/ui/badge";
import { Select } from "../../../shared/frontend/ui/select";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "../../../shared/frontend/ui/table";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";
import { PageHeader } from "../../../shared/frontend/components/PageHeader";
import { EmptyState } from "../../../shared/frontend/components/EmptyState";

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
        <PageHeader title="Recommendations" />
        <EmptyState
          title="No recommendations yet"
          description="Import content and products, then wait for trend matching."
        />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-8">
      <PageHeader
        title="Top Recommendations"
        actions={
          <Select
            value={member?.preferred_location}
            onChange={(e) => updateLocation(e.target.value)}
            className="text-sm"
          >
            <option value="global">Global</option>
            <option value="china">China</option>
          </Select>
        }
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-1/3">Trend</TableHead>
            <TableHead className="w-1/3">Content</TableHead>
            <TableHead className="w-1/3">Product</TableHead>
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
