import { useTwitterChannel } from "../hooks/useTwitterChannel";

function TwitterIcon() {
  return (
    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  );
}

export function TwitterConnect() {
  const { connected, username, loading, connect, disconnect } = useTwitterChannel();

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
          <TwitterIcon />
          <span className="text-sm font-medium text-gray-700">Twitter</span>
        </div>
        <p className="text-gray-500 text-sm mb-3">Connect to sync followers and receive events</p>
        <button
          onClick={connect}
          className="px-3 py-1.5 text-sm bg-black text-white rounded-md hover:bg-gray-800"
        >
          Connect Twitter
        </button>
      </div>
    );
  }

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TwitterIcon />
          <span className="text-sm font-medium text-gray-700">Twitter</span>
          {username && (
            <span className="text-xs text-gray-400">@{username}</span>
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
