import { scoreClass } from "../utils";

interface ScoreProps {
  value: number | null;
  large?: boolean;
}

export function Score({ value, large }: ScoreProps) {
  if (value === null) return <span className="score">--</span>;
  return (
    <span className={`score ${scoreClass(value)} ${large ? "score-lg" : ""}`}>
      {value}
    </span>
  );
}
