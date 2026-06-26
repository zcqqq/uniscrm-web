import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createReport } from "../lib/api";

const EVENT_TYPES = [
  { value: "follow.follow", label: "X Follow (关注)" },
  { value: "follow.followed", label: "X Followed (被关注)" },
  { value: "follow.unfollow", label: "X Unfollow (取关)" },
  { value: "follow.unfollowed", label: "X Unfollowed (被取关)" },
  { value: "dm.received", label: "X DM Received (收到私信)" },
];

export function AnalysisCreate() {
  const navigate = useNavigate();
  const [eventTypeA, setEventTypeA] = useState("");
  const [eventTypeB, setEventTypeB] = useState("");
  const [timeStart, setTimeStart] = useState("");
  const [timeEnd, setTimeEnd] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!eventTypeA || !eventTypeB) {
      setError("Please select both events");
      return;
    }
    if (eventTypeA === eventTypeB) {
      setError("Initial event and follow-up event must be different");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const res = await createReport({
        type: "interval",
        params: {
          event_type_a: eventTypeA,
          event_type_b: eventTypeB,
          time_range_start: timeStart || undefined,
          time_range_end: timeEnd || undefined,
        },
      });
      navigate(`/intervals/${res.report.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create analysis");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-xl font-semibold text-foreground mb-6">New Interval Analysis</h1>

      <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="bg-card rounded-lg border border-border p-6 space-y-5">
        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Initial Event (A)</label>
          <select
            value={eventTypeA}
            onChange={(e) => setEventTypeA(e.target.value)}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">Select event...</option>
            {EVENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-center">
          <div className="text-muted-foreground/60 text-lg">↓</div>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1">Follow-up Event (B)</label>
          <select
            value={eventTypeB}
            onChange={(e) => setEventTypeB(e.target.value)}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">Select event...</option>
            {EVENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">Start Date (optional)</label>
            <input
              type="date"
              value={timeStart}
              onChange={(e) => setTimeStart(e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">End Date (optional)</label>
            <input
              type="date"
              value={timeEnd}
              onChange={(e) => setTimeEnd(e.target.value)}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        {error && (
          <div className="bg-red-50 text-red-700 px-3 py-2 rounded text-sm">{error}</div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full px-4 py-2.5 bg-primary text-white text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? "Submitting..." : "Submit Analysis"}
        </button>
      </form>

      <p className="mt-4 text-xs text-muted-foreground">
        Computes the time interval between event A → B using R2 SQL window functions.
        Results available in seconds after submission.
      </p>
    </div>
  );
}
