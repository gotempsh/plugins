interface StatCardProps {
  label: string;
  value: string | number;
  color?: string;
}

export function StatCard({ label, value, color }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className="label">{label}</div>
      <div className="value" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}
