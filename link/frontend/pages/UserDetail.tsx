import { useParams, Link } from "react-router-dom";
import { useState, useEffect, useCallback } from "react";
import { api, type XUser, type XEvent } from "../lib/api";


const EVENT_LABELS: Record<string, string> = {
  follower: "Follower",
  follow_event: "New Follow",
  chat_received: "Message",
};

export function UserDetail() {
  useEffect(() => { document.title = "Users — UniSCRM" }, []);
  const { id } = useParams<{ id: string }>();
  const [user, setUser] = useState<XUser | null>(null);
  const [events, setEvents] = useState<XEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadUser = useCallback(async () => {
    if (!id) return;
    try {
      const data = await api.users.get(id);
      setUser(data.user);
    } catch {
      setUser(null);
    }
  }, [id]);

  const loadEvents = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const data = await api.users.events(id, 0, 100);
      setEvents(data.events);
      setHasMore(data.hasMore);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { loadUser(); loadEvents(); }, [loadUser, loadEvents]);

  const loadMore = async () => {
    if (!id) return;
    const data = await api.users.events(id, events.length, 100);
    setEvents([...events, ...data.events]);
    setHasMore(data.hasMore);
  };

  if (!user && !loading) {
    return (
      <main className="max-w-4xl mx-auto px-8 py-8">
        <p className="text-muted-foreground">User not found.</p>
        <Link to="/users" className="text-sm text-primary hover:underline">Back to users</Link>
      </main>
    );
  }

  return (
    <main className="max-w-4xl mx-auto px-8 py-8">
      <Link to="/users" className="text-sm text-muted-foreground hover:text-black mb-4 inline-block">&larr; Back</Link>

      {user && (
        <>
          <div className="flex items-center gap-3 mb-4">
            {user.profile_image_url ? (
              <img src={user.profile_image_url} alt="" className="w-12 h-12 rounded-full" />
            ) : (
              <div className="w-12 h-12 rounded-full bg-gray-200" />
            )}
            <div>
              <div className="text-lg font-semibold">{user.name}</div>
              <div className="text-sm text-muted-foreground">@{user.username}</div>
            </div>
          </div>

          {user.socials && Object.keys(JSON.parse(user.socials || "{}")).length > 0 && (
            <div className="mb-6 p-3 bg-card border rounded-lg">
              <h3 className="text-xs font-medium text-muted-foreground mb-2">Other Platforms</h3>
              <div className="flex flex-wrap gap-2">
                {Object.entries(JSON.parse(user.socials || "{}") as Record<string, string>).map(([platform, profileUrl]) => (
                  <a
                    key={platform}
                    href={profileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100"
                  >
                    {platform}
                  </a>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <h2 className="text-sm font-medium text-foreground mb-3">Events ({events.length}{hasMore ? "+" : ""})</h2>

      {loading ? (
        <div className="animate-pulse space-y-2">
          {[...Array(5)].map((_, i) => <div key={i} className="h-10 bg-gray-200 rounded" />)}
        </div>
      ) : events.length === 0 ? (
        <p className="text-muted-foreground text-sm">No events recorded.</p>
      ) : (
        <div className="bg-card rounded-lg border divide-y">
          {events.map((event) => (
            <div key={event.id} className="flex items-center gap-3 px-4 py-2">
              <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-muted-foreground font-medium">
                {EVENT_LABELS[event.event_type] || event.event_type}
              </span>
              <span className="text-xs text-muted-foreground/60 flex-1">
                {event.event_time ? new Date(event.event_time).toLocaleString() : "—"}
              </span>
            </div>
          ))}
        </div>
      )}

      {hasMore && (
        <button
          onClick={loadMore}
          className="mt-4 w-full py-2 text-sm text-muted-foreground border rounded hover:bg-background"
        >
          Load more
        </button>
      )}
    </main>
  );
}
