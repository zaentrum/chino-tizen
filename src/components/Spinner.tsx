// Centred loading spinner. Screens render this while their first data fetch is
// in flight (the contract requires a <Spinner> on every loading screen). Pure
// CSS ring — no extra deps — sized for a 10-foot read.

interface SpinnerProps {
  /** Optional label rendered under the ring (e.g. "Loading library…"). */
  label?: string;
  /** When true, fill the parent and centre; otherwise render inline. */
  fullscreen?: boolean;
}

export function Spinner({ label, fullscreen = true }: SpinnerProps) {
  const ring = (
    <div className="flex flex-col items-center gap-4">
      <div
        className="h-12 w-12 animate-spin rounded-full border-4 border-border-2 border-t-accent"
        role="status"
        aria-label={label ?? 'Loading'}
      />
      {label ? <p className="text-muted">{label}</p> : null}
    </div>
  );
  if (!fullscreen) return ring;
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-bg text-text">
      {ring}
    </div>
  );
}

export default Spinner;
