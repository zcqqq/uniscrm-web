export default function AnalyticsBadges({ analytics }: { analytics?: { enter: number; exit: number } | null }) {
  if (!analytics) return null;
  return (
    <div className="flex justify-between mt-1 text-[10px] font-medium">
      <span className="px-1 rounded bg-green-100 text-green-700">{analytics.enter}</span>
      <span className="px-1 rounded bg-gray-100 text-gray-500">{analytics.exit}</span>
    </div>
  );
}
