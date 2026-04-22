interface CheckProps {
  pass: boolean;
  label: string;
}

export function Check({ pass, label }: CheckProps) {
  return (
    <div className={`check ${pass ? "check-pass" : "check-fail"}`}>
      {pass ? "\u2713" : "\u2717"} {label}
    </div>
  );
}
