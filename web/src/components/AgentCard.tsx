import type { AgentRow } from "../api.ts";
import { formatDurationMs, formatTokens } from "../lib/format.ts";
import { LockSymbol } from "./icons.tsx";

/**
 * One live-worker row. Pure projection over the server-derived AgentRow
 * (arch §1: point-in-time derivation, never a second agent-state model).
 * The mutex column reuses the TUI rule: `verifying` holds the commit mutex.
 */
export function isMutexHolder(status: string): boolean {
  return status === "verifying";
}

/** Compact usage cell: tokens where available, always turns/tools. */
export function formatUsage(metrics: AgentRow["metrics"]): string {
  if (!metrics) return "—";
  const work = `${metrics.turns}t/${metrics.tools}tl`;
  const total = metrics.tokens?.total;
  if (typeof total !== "number") return work;
  return `${formatTokens(total)} (${work})`;
}

export default function AgentCard({
  agent,
  selected = false,
  onSelect,
}: {
  agent: AgentRow;
  selected?: boolean;
  onSelect?: (sliceId: string) => void;
}) {
  const locked = isMutexHolder(agent.status);
  const usage = formatUsage(agent.metrics);
  const usageTitle =
    agent.metrics?.tokens !== undefined
      ? `in ${agent.metrics.tokens.input} / out ${agent.metrics.tokens.output} / total ${agent.metrics.tokens.total} · ${agent.metrics.turns} turns / ${agent.metrics.tools} tools`
      : agent.metrics
        ? `${agent.metrics.turns} turns / ${agent.metrics.tools} tools`
        : "no finished worker yet";
  return (
    <tr
      data-selected={selected ? "true" : "false"}
      aria-selected={selected}
      onClick={() => onSelect?.(agent.id)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect?.(agent.id);
        }
      }}
      title={agent.lastLine || undefined}
    >
      <td>L{agent.lane}</td>
      <td>
        <code>{agent.id}</code>
        {agent.agent ? (
          <div className="omp-sub omp-ellipsis" title={agent.agent}>
            {agent.agent}
            {agent.effort ? ` · ${agent.effort}` : ""}
          </div>
        ) : agent.effort ? (
          <div className="omp-sub">{agent.effort}</div>
        ) : null}
      </td>
      <td>
        <StatusBadge status={agent.status} />
      </td>
      <td>
        {agent.attempt}
        <span className="omp-sub"> g{agent.generation}</span>
      </td>
      <td title={typeof agent.metrics?.durationMs === "number" ? `${agent.metrics.durationMs}ms (last worker_finished)` : "no finished worker yet"}>
        {formatDurationMs(agent.metrics?.durationMs)}
      </td>
      <td title={usageTitle}>{usage}</td>
      <td title={locked ? "holds the verify+merge commit mutex" : "not holding the mutex"}>
        {locked ? (
          <span className="omp-mutex">
            <LockSymbol />
            <span className="omp-sr-only">holds mutex</span>
          </span>
        ) : (
          "—"
        )}
      </td>
      <td>
        <div className="omp-ellipsis" title={agent.lastLine}>
          {agent.lastLine || "—"}
        </div>
      </td>
    </tr>
  );
}
