import { formatMetric, metricRating } from "../utils";

interface MetricCardProps {
  label: string;
  metricKey: string;
  value: number | null;
  unit: string;
}

export function MetricCard({ label, metricKey, value, unit }: MetricCardProps) {
  const rating = metricRating(metricKey, value);

  return (
    <div className="metric-card">
      <div className="label">{label}</div>
      <div className={`value metric-${rating}`}>
        {formatMetric(value, unit)}
      </div>
      {rating !== "none" && (
        <div className={`rating metric-${rating}`}>
          {rating === "good" ? "Good" : rating === "needs-improvement" ? "Needs work" : "Poor"}
        </div>
      )}
    </div>
  );
}
