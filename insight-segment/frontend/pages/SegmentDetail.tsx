import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, type Segment, type SegmentUser } from "../lib/api";
import { PageHeader } from "../../../shared/frontend/components/PageHeader";
import { Button } from "../../../shared/frontend/ui/button";
import { Card, CardContent } from "../../../shared/frontend/ui/card";
import { Skeleton } from "../../../shared/frontend/ui/skeleton";

export function SegmentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [segment, setSegment] = useState<Segment | null>(null);
  const [users, setUsers] = useState<SegmentUser[]>([]);
  const [userPage, setUserPage] = useState(1);
  const [userTotalPages, setUserTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);

  useEffect(() => {
    if (!id) return;
    api.getSegment(id).then((data) => {
      setSegment(data.segment);
      setLoading(false);
    });
  }, [id]);

  useEffect(() => {
    if (!id || !segment || segment.status !== "ready") return;
    api.getUsers(id, userPage).then((data) => {
      setUsers(data.users);
      setUserTotalPages(data.totalPages);
    });
  }, [id, segment?.status, userPage]);

  const handleCompute = async () => {
    if (!id) return;
    setComputing(true);
    try {
      const result = await api.compute(id);
      setSegment((prev) => prev ? { ...prev, status: result.segment.status, user_count: result.segment.user_count } : prev);
    } catch {
      setSegment((prev) => prev ? { ...prev, status: "error" } : prev);
    } finally {
      setComputing(false);
    }
  };

  const handleDelete = async () => {
    if (!id || !confirm("Delete this segment?")) return;
    await api.deleteSegment(id);
    navigate("/");
  };

  if (loading) return <div className="p-8"><Skeleton className="h-6 w-48" /></div>;
  if (!segment) return <div className="p-8 text-destructive">Segment not found</div>;

  return (
    <div className="max-w-4xl mx-auto p-8">
      <PageHeader
        title={segment.name}
        actions={
          <>
            {segment.status === "draft" && (
              <Button
                onClick={handleCompute}
                disabled={computing}
                variant="default"
              >
                {computing ? "Computing..." : "Compute"}
              </Button>
            )}
            {segment.status === "ready" && (
              <Button
                onClick={handleCompute}
                disabled={computing}
                variant="outline"
              >
                {computing ? "Recomputing..." : "Recompute"}
              </Button>
            )}
            <Button onClick={handleDelete} variant="destructive">
              Delete
            </Button>
          </>
        }
      />

      <Card className="mb-6">
        <CardContent className="p-4 space-y-3">
          <div className="text-sm"><strong>Query:</strong> {segment.nl_query}</div>
          <div className="text-sm"><strong>Status:</strong> {segment.status} &middot; <strong>Users:</strong> {segment.user_count}</div>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">Conditions & SQL</summary>
            <pre className="mt-2 text-xs bg-background rounded p-2 overflow-x-auto">
              {JSON.stringify(JSON.parse(segment.conditions_json || "{}"), null, 2)}
            </pre>
            <pre className="mt-2 text-xs bg-background rounded p-2 overflow-x-auto">{segment.sql_query}</pre>
          </details>
        </CardContent>
      </Card>

      {segment.status === "ready" && users.length > 0 && (
        <div>
          <h2 className="text-lg font-medium mb-3">Users ({segment.user_count})</h2>
          <div className="bg-card border rounded divide-y">
            {users.map((u) => (
              <div key={u.id} className="flex items-center gap-3 p-3">
                {u.profile_image_url && (
                  <img src={u.profile_image_url} alt="" className="w-8 h-8 rounded-full" />
                )}
                <div>
                  <div className="font-medium text-sm">{u.name || u.username || u.id}</div>
                  {u.username && <div className="text-xs text-muted-foreground/60">@{u.username}</div>}
                </div>
              </div>
            ))}
          </div>
          {userTotalPages > 1 && (
            <div className="flex justify-center gap-2 mt-4">
              <Button variant="outline" size="sm" disabled={userPage <= 1} onClick={() => setUserPage(userPage - 1)}>Prev</Button>
              <span className="px-3 py-1 text-sm text-muted-foreground">{userPage} / {userTotalPages}</span>
              <Button variant="outline" size="sm" disabled={userPage >= userTotalPages} onClick={() => setUserPage(userPage + 1)}>Next</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
