import { useState } from "react";
import { useRecommendations } from "../hooks/useRecommendations";

export function Home() {
  const { recommendations, loading } = useRecommendations();
  const [expanded, setExpanded] = useState<string | null>(null);

  if (loading) {
    return <div className="max-w-4xl mx-auto p-8"><p className="text-gray-500">Loading recommendations...</p></div>;
  }

  if (recommendations.length === 0) {
    return (
      <div className="max-w-4xl mx-auto p-8">
        <h1 className="text-2xl font-bold mb-4">Recommendations</h1>
        <p className="text-gray-500">No recommendations yet. Import content and wait for trend matching.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-6">Top Recommendations</h1>
      <div className="space-y-4">
        {recommendations.map((rec) => {
          const bestScore = Math.max(...rec.matches.map((m) => m.similarity));
          const isExpanded = expanded === rec.content_id;
          return (
            <div key={rec.content_id} className="bg-white rounded-lg border p-4">
              <div
                className="flex items-center justify-between cursor-pointer"
                onClick={() => setExpanded(isExpanded ? null : rec.content_id)}
              >
                <div>
                  <h3 className="font-semibold">{rec.title}</h3>
                  <span className="text-sm text-gray-500">{rec.matches.length} matching trends</span>
                </div>
                <span className="text-sm font-mono bg-blue-50 text-blue-700 px-2 py-1 rounded">
                  {(bestScore * 100).toFixed(0)}% match
                </span>
              </div>
              {isExpanded && (
                <div className="mt-3 pt-3 border-t">
                  {rec.matches.map((m) => (
                    <div key={m.trend_id} className="flex justify-between py-1 text-sm">
                      <span>{m.title}</span>
                      <span className="text-gray-400">{m.platform} · {(m.similarity * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
