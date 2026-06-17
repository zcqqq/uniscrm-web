import { useTikTokChannel } from "../hooks/useTikTokChannel";

function TikTokIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.88 2.89 2.89 0 01-2.88-2.88 2.89 2.89 0 012.88-2.88c.28 0 .54.04.79.1V9.4a6.33 6.33 0 00-.79-.05A6.34 6.34 0 003.15 15.7 6.34 6.34 0 009.49 22a6.34 6.34 0 006.34-6.34V9.04a8.16 8.16 0 004.77 1.52V7.11a4.85 4.85 0 01-1.01-.42z"/>
    </svg>
  );
}

export function TikTokConnect() {
  const { connected, displayName, loading, connect, disconnect } = useTikTokChannel();

  if (loading) {
    return (
      <div className="border rounded-lg p-6 animate-pulse">
        <div className="h-4 bg-gray-200 rounded w-24" />
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="border-2 border-dashed rounded-lg p-6 text-center border-gray-300">
        <div className="flex items-center justify-center gap-2 mb-2">
          <TikTokIcon />
          <span className="text-sm font-medium text-gray-700">TikTok</span>
        </div>
        <p className="text-gray-500 text-sm mb-3">Connect your TikTok account</p>
        <button
          onClick={connect}
          className="px-3 py-1.5 text-sm bg-black text-white rounded-md hover:bg-gray-800"
        >
          Connect TikTok
        </button>
      </div>
    );
  }

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TikTokIcon />
          <span className="text-sm font-medium text-gray-700">TikTok</span>
          {displayName && (
            <span className="text-xs text-gray-400">{displayName}</span>
          )}
        </div>
        <button
          onClick={disconnect}
          className="text-sm text-red-600 hover:text-red-800"
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}
