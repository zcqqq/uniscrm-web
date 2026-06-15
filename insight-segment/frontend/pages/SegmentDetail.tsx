import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, type Segment, type SegmentUser } from "../lib/api";

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

  if (loading) return <div className="p-8 text-gray-400">Loading...</div>;
  if (!segment) return <div className="p-8 text-red-500">Segment not found</div>;

  return (
    <div className="max-w-4xl mx-auto p-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-xl font-semibold">{segment.name}</h1>
        <div className="flex gap-2">
          {segment.status === "draft" && (
            <button
              onClick={handleCompute}
              disabled={computing}
              className="px-4 py-2 bg-black text-white rounded text-sm hover:bg-gray-800 disabled:opacity-30"
            >
              {computing ? "Computing..." : "Compute"}
            </button>
          )}
          {segment.status === "ready" && (
            <button
              onClick={handleCompute}
              disabled={computing}
              className="px-4 py-2 border rounded text-sm hover:bg-gray-50 disabled:opacity-30"
            >
              {computing ? "Recomputing..." : "Recompute"}
            </button>
          )}
          <button onClick={handleDelete} className="px-4 py-2 border border-red-200 text-red-600 rounded text-sm hover:bg-red-50">
            Delete
          </button>
        </div>
      </div>

      <div className="bg-white border rounded p-4 space-y-3 mb-6">
        <div className="text-sm"><strong>Query:</strong> {segment.nl_query}</div>
        <div className="text-sm"><strong>Status:</strong> {segment.status} &middot; <strong>Users:</strong> {segment.user_count}</div>
        <details className="text-sm">
          <summary className="cursor-pointer text-gray-500">Conditions & SQL</summary>
          <pre className="mt-2 text-xs bg-gray-50 rounded p-2 overflow-x-auto">
            {JSON.stringify(JSON.parse(segment.conditions_json || "{}"), null, 2)}
          </pre>
          <pre className="mt-2 text-xs bg-gray-50 rounded p-2 overflow-x-auto">{segment.sql_query}</pre>
        </details>
      </div>

      {segment.status === "ready" && users.length > 0 && (
        <div>
          <h2 className="text-lg font-medium mb-3">Users ({segment.user_count})</h2>
          <div className="bg-white border rounded divide-y">
            {users.map((u) => (
              <div key={u.id} className="flex items-center gap-3 p-3">
                {u.profile_image_url && (
                  <img src={u.profile_image_url} alt="" className="w-8 h-8 rounded-full" />
                )}
                <div>
                  <div className="font-medium text-sm">{u.name || u.username || u.id}</div>
                  {u.username && <div className="text-xs text-gray-400">@{u.username}</div>}
                </div>
              </div>
            ))}
          </div>
          {userTotalPages > 1 && (
            <div className="flex justify-center gap-2 mt-4">
              <button disabled={userPage <= 1} onClick={() => setUserPage(userPage - 1)} className="px-3 py-1 border rounded disabled:opacity-30">Prev</button>
              <span className="px-3 py-1 text-sm text-gray-500">{userPage} / {userTotalPages}</span>
              <button disabled={userPage >= userTotalPages} onClick={() => setUserPage(userPage + 1)} className="px-3 py-1 border rounded disabled:opacity-30">Next</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
