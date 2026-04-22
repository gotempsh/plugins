import { scoreClass } from "../utils";

interface ScoreProps {
  value: number;
  large?: boolean;
}

export function Score({ value, large }: ScoreProps) {
  return (
    <span className={`score ${scoreClass(value)} ${large ? "score-lg" : ""}`}>
      {value}
    </span>
  );
}
