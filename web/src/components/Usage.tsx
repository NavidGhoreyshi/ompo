import type { GenerationUsage, SliceDetail, TokenUsage } from "../api.ts";
import { formatDurationMs, formatTokens } from "../lib/format.ts";

/**
 * Usage tab: authoritative model spend, never estimates.
 *
 * Labels match the verified `--mode json` envelope semantics in
 * src/worker.ts `usageForEvent` (live omp 18.1.14 `message.usage` on
 * assistant message_end / turn_end):
 * - Input: fresh (non-cached) input tokens (`usage.input`).
 * - Output: generated tokens, reasoning included (`usage.output`).
 * - Cache read: prompt-cache hit tokens (`usage.cacheRead`).
 * - Cache write: cache-creation tokens (`usage.cacheWrite`).
 * - Reasoning: sub-count of Output spent on reasoning, NOT additive
 *   (`usage.reasoningTokens`).
 * - Total: authoritative total (`usage.totalTokens`, else
 *   input+output+cacheRead+cacheWrite).
 * - Cost: authoritative USD breakdown (`usage.cost`, `cost.total`).
 *
 * Older envelopes omit optional fields and tmux runs report no envelope at
 * all — unknown cells render "—", never 0 or a projection.
 */

/** Compact token count; "—" when the envelope omitted the field. */
export function fmtCount(v: number | undefined): string {
  return typeof v === "number" ? formatTokens(v) : "—";
}

/** Authoritative USD; "—" when the envelope omitted cost. Never estimated. */
export function formatCostUsd(v: number | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return "—";
  if (v === 0) return "$0.00";
  if (v >= 0.01) return `$${v.toFixed(2)}`;
  if (v >= 0.0001) return `$${v.toFixed(4)}`;
  return `$${v.toExponential(2)}`;
}

/** Full breakdown tooltip for one envelope (exact values, no compaction). */
export function usageTitle(u: TokenUsage): string {
  const parts = [`in ${u.input}`, `out ${u.output}`];
  if (u.cacheRead !== undefined) parts.push(`cache-read ${u.cacheRead}`);
  if (u.cacheWrite !== undefined) parts.push(`cache-write ${u.cacheWrite}`);
  if (u.reasoningTokens !== undefined) parts.push(`reasoning ${u.reasoningTokens} (in out)`);
  parts.push(`total ${u.total}`);
  if (u.cost !== undefined) parts.push(`cost $${u.cost.total}`);
  return parts.join(" / ");
}

/**
 * Sum per-generation session envelopes into slice spend. Each generation is
 * a fresh session, so totals add. A field is present only when at least one
 * envelope reported it — never zero-filled. Pure, unit-tested.
 */
export function sumUsages(usages: (TokenUsage | undefined)[]): TokenUsage | undefined {
  const known = usages.filter((u): u is TokenUsage => u !== undefined);
  if (known.length === 0) return undefined;
  const field = (pick: (u: TokenUsage) => number | undefined): number | undefined => {
    let sum = 0;
    let seen = false;
    for (const u of known) {
      const v = pick(u);
      if (typeof v === "number") {
        sum += v;
        seen = true;
      }
    }
    return seen ? sum : undefined;
  };
  const out: TokenUsage = {
    input: field((u) => u.input) ?? 0,
    output: field((u) => u.output) ?? 0,
    total: field((u) => u.total) ?? 0,
  };
  const cacheRead = field((u) => u.cacheRead);
  if (cacheRead !== undefined) out.cacheRead = cacheRead;
  const cacheWrite = field((u) => u.cacheWrite);
  if (cacheWrite !== undefined) out.cacheWrite = cacheWrite;
  const reasoningTokens = field((u) => u.reasoningTokens);
  if (reasoningTokens !== undefined) out.reasoningTokens = reasoningTokens;
  const costFields = (pick: (c: NonNullable<TokenUsage["cost"]>) => number): number => {
    let sum = 0;
    for (const u of known) {
      const c = u.cost;
      if (c !== undefined) sum += pick(c);
    }
    return sum;
  };
  if (known.some((u) => u.cost !== undefined)) {
    out.cost = {
      input: costFields((c) => c.input),
      output: costFields((c) => c.output),
      cacheRead: costFields((c) => c.cacheRead),
      cacheWrite: costFields((c) => c.cacheWrite),
      total: costFields((c) => c.total),
    };
  }
  return out;
}

/** Six-field authoritative breakdown for one run (last run or one generation). */
export function UsageBreakdown({ usage }: { usage: TokenUsage | undefined }) {
  if (!usage) return <p className="omp-hint">no usage reported — the worker stream carried no usage envelope</p>;
  return (
    <dl className="omp-kv">
      <div>
        <dt title="fresh (non-cached) input tokens — message.usage.input">Input</dt>
        <dd title={usageTitle(usage)}>{fmtCount(usage.input)}</dd>
      </div>
      <div>
        <dt title="generated tokens, reasoning included — message.usage.output">Output</dt>
        <dd title={usageTitle(usage)}>{fmtCount(usage.output)}</dd>
      </div>
      <div>
        <dt title="prompt-cache hit tokens — message.usage.cacheRead">Cache read</dt>
        <dd title={usageTitle(usage)}>{fmtCount(usage.cacheRead)}</dd>
      </div>
      <div>
        <dt title="cache-creation tokens — message.usage.cacheWrite">Cache write</dt>
        <dd title={usageTitle(usage)}>{fmtCount(usage.cacheWrite)}</dd>
      </div>
      <div>
        <dt title="sub-count of Output spent on reasoning, not additive — message.usage.reasoningTokens">Reasoning</dt>
        <dd title={usageTitle(usage)}>{fmtCount(usage.reasoningTokens)}</dd>
      </div>
      <div>
        <dt title="authoritative total — message.usage.totalTokens">Total</dt>
        <dd title={usageTitle(usage)}>{fmtCount(usage.total)}</dd>
      </div>
      <div>
        <dt title="authoritative USD — message.usage.cost.total">Cost</dt>
        <dd
          title={
            usage.cost
              ? `in $${usage.cost.input} / out $${usage.cost.output} / cache-read $${usage.cost.cacheRead} / cache-write $${usage.cost.cacheWrite} / total $${usage.cost.total}`
              : "the envelope omitted cost"
          }
        >
          {formatCostUsd(usage.cost?.total)}
        </dd>
      </div>
    </dl>
  );
}

function generationTokensCell(g: GenerationUsage): { text: string; title: string } {
  if (g.usage) return { text: fmtCount(g.usage.total), title: usageTitle(g.usage) };
  if (g.tokensTotal !== undefined)
    return {
      text: formatTokens(g.tokensTotal),
      title: `total-only handoff record (${g.tokensTotal} tokens) — no usage envelope observed for this generation`,
    };
  return { text: "—", title: "no usage observed for this generation" };
}

function generationCostCell(g: GenerationUsage): { text: string; title: string } {
  const total = g.usage?.cost?.total;
  if (total === undefined)
    return {
      text: "—",
      title: g.usage ? "the envelope omitted cost" : "no usage observed for this generation",
    };
  const c = g.usage!.cost!;
  return {
    text: formatCostUsd(total),
    title: `in $${c.input} / out $${c.output} / cache-read $${c.cacheRead} / cache-write $${c.cacheWrite} / total $${c.total}`,
  };
}

/**
 * Usage tab body: last-run breakdown plus one row per fresh-context
 * generation (token usage, duration, cost). Unknown renders "—".
 */
export default function Usage({ detail }: { detail: SliceDetail | null }) {
  const tokens = detail?.metrics?.tokens;
  const generations = detail?.generations ?? [];
  const reported = generations.filter((g) => g.usage !== undefined || g.tokensTotal !== undefined).length;
  const sliceTotal = sumUsages(generations.map((g) => g.usage));

  return (
    <div aria-label="Usage">
      <h3>Last run</h3>
      <UsageBreakdown usage={tokens} />

      <h3>Generations{reported > 0 ? ` · slice total ${sliceTotal ? formatTokens(sliceTotal.total) : "—"}` : ""}</h3>
      {generations.length === 0 ? (
        <p className="omp-hint">no generations yet — rows land when attempt workers spawn</p>
      ) : (
        <div className="omp-table-wrap">
          <table className="omp-table" data-table="usage">
            <thead>
              <tr>
                <th scope="col">Generation</th>
                <th scope="col">Tokens</th>
                <th scope="col">Duration</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {generations.map((g) => {
                const tok = generationTokensCell(g);
                const cost = generationCostCell(g);
                return (
                  <tr key={`${g.attempt}:g${g.generation}`}>
                    <td>
                      <code>
                        a{g.attempt}·g{g.generation}
                      </code>
                    </td>
                    <td title={tok.title}>{tok.text}</td>
                    <td title={typeof g.durationMs === "number" ? `${g.durationMs}ms` : "no duration recorded"}>
                      {formatDurationMs(g.durationMs)}
                    </td>
                    <td title={cost.title}>{cost.text}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {generations.length > 0 && reported < generations.length && (
        <p className="omp-hint">
          partial — {reported} of {generations.length} generations reported usage; the rest show "—", never estimates
        </p>
      )}
      {generations.length > 0 && reported === generations.length && sliceTotal?.cost && (
        <p className="omp-hint">slice total cost {formatCostUsd(sliceTotal.cost.total)} (sum of generation sessions)</p>
      )}
      <p className="omp-hint">authoritative `--mode json` usage only — tmux runs and older envelopes omit fields, shown as "—"</p>
    </div>
  );
}
