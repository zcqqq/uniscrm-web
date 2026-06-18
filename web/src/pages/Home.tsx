import { useRecommendations } from "../hooks/useRecommendations";
import { useAuth } from "../hooks/useAuth";

function ScoreBadge({ score }: { score: number }) {
  return (
    <span className="text-xs font-mono bg-primary/10 text-primary px-1.5 py-0.5 rounded">
      {(score * 100).toFixed(0)}%
    </span>
  );
}

export function Home() {
  const { member, updateLocation } = useAuth();
  const { recommendations, loading } = useRecommendations();

  if (loading) {
    return <div className="max-w-5xl mx-auto p-8"><p className="text-gray-500">Loading recommendations...</p></div>;
  }

  if (recommendations.length === 0) {
    return (
      <div className="max-w-5xl mx-auto p-8">
        <h1 className="text-2xl font-bold mb-4">Recommendations</h1>
        <p className="text-gray-500">No recommendations yet. Import content and products, then wait for trend matching.</p>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Top Recommendations</h1>
        <select
          value={member?.preferred_location}
          onChange={(e) => updateLocation(e.target.value)}
          className="text-sm border rounded px-3 py-1.5"
        >
          <option value="global">Global</option>
          <option value="china">China</option>
        </select>
      </div>
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b text-left">
            <th className="py-2 px-3 font-medium w-1/3">Trend</th>
            <th className="py-2 px-3 font-medium w-1/3">Content</th>
            <th className="py-2 px-3 font-medium w-1/3">Product</th>
          </tr>
        </thead>
        <tbody>
          {recommendations.map((group, i) => (
            <tr key={i} className="border-b hover:bg-gray-50">
              <td className="py-3 px-3">
                {group.trend ? (
                  <div>
                    <div className="font-medium">{group.trend.title}</div>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="text-xs text-gray-400">{group.trend.platform}</span>
                      {group.trend.similarity < 1 && <ScoreBadge score={group.trend.similarity} />}
                    </div>
                  </div>
                ) : (
                  <span className="text-gray-300">{"—"}</span>
                )}
              </td>
              <td className="py-3 px-3">
                {group.content ? (
                  <div>
                    <div className="font-medium truncate max-w-xs">{group.content.title}</div>
                    <ScoreBadge score={group.content.similarity} />
                  </div>
                ) : (
                  <span className="text-gray-300">{"—"}</span>
                )}
              </td>
              <td className="py-3 px-3">
                {group.product ? (
                  <div>
                    <div className="font-medium truncate max-w-xs">{group.product.title}</div>
                    <ScoreBadge score={group.product.similarity} />
                  </div>
                ) : (
                  <span className="text-gray-300">{"—"}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
