/** Shared formatting for the Overview operating view. Pure, no DOM. */

/** Elapsed wall-clock between two ISO timestamps. "—" when unparseable. */
export function formatElapsed(createdAt: string, updatedAt: string): string {
  const start = Date.parse(createdAt);
  const end = Date.parse(updatedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "—";
  return formatSpan(end - start);
}

/** Compact human span for a millisecond count. */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Single duration value (worker_finished durationMs). "—" when unknown. */
export function formatDurationMs(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatSpan(ms);
}

/** Compact token count: exact under 1k, then 12.3k / 1.2M. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  const m = n / 1_000_000;
  return `${m >= 100 ? Math.round(m) : m.toFixed(1)}M`;
}
