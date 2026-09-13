/**
 * The flat deck (`d09`): the same `DeckModel` and the same DTOs as the 3D
 * surface, rendered as a document instead of a scene — for a device with no
 * WebGL2, and for an operator who chose flat mode with `T`.
 *
 * It adds no derivation of its own. The board and the worker lanes are the
 * dashboard's own components (`SliceTable`, `WorkerLanes`), so the flat deck
 * reads exactly like the 2D workspace the operator already knows; the pad list
 * is `flatRows(model)` — the same information the rail encodes (status glyph,
 * stage, alert kind, live/stalled marker), so nothing the 3D surface conveys is
 * lost in the fallback. The live window, alerts, history and the dock arrive
 * from the shared overlay/dock around it.
 */

import type { AgentRow, RunEvent, SliceSummary } from "../api.ts";
import SliceTable from "../components/SliceTable.tsx";
import WorkerLanes from "../components/WorkerLanes.tsx";
import { flatRowLabel, flatRows } from "./fallback.ts";
import { useRovingFocus } from "./roving.ts";
import type { DeckModel } from "./types.ts";

export default function FlatDeck({
  model,
  slices,
  agents,
  events,
  selected,
  live,
  onSelect,
}: {
  model: DeckModel;
  /** The run's slice DTOs — the board's input, verbatim. */
  slices: SliceSummary[];
  agents: AgentRow[];
  events: RunEvent[];
  /** The app's selection (the dock's subject) — not the deck's focus. */
  selected: string | null;
  live: boolean;
  onSelect: (sliceId: string) => void;
}) {
  const rows = flatRows(model);
  const roving = useRovingFocus(
    rows.map((row) => row.id),
    selected,
  );

  return (
    <div className="omp-deck-flatgrid">
      <section className="omp-deck-flatboard" aria-label="Slices">
        <span className="omp-section-label">Slices</span>
        <SliceTable slices={slices} selected={selected} onSelect={onSelect} events={events} agents={agents} />
      </section>

      <section className="omp-deck-flatpads" aria-label="Rail, flattened">
        <span className="omp-section-label">Rail, flattened</span>
        <p className="omp-deck-flatnote">
          Every pad the 3D rail draws, in text — status, stage, alerts and the live marker included.
        </p>
        <ul className="omp-deck-pads" onKeyDown={roving.onKeyDown}>
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="omp-deck-padrow"
                data-selected={row.selected ? "true" : "false"}
                data-focused={row.focused ? "true" : "false"}
                data-live={row.live ? "true" : "false"}
                data-alert={row.alert ?? "none"}
                title={flatRowLabel(row)}
                ref={roving.register(row.id)}
                tabIndex={roving.tabIndexFor(row.id)}
                onFocus={() => roving.activate(row.id)}
                onClick={() => onSelect(row.id)}
              >
                <span aria-hidden="true" className="omp-deck-padglyph">
                  {row.glyph}
                </span>
                <code className="omp-deck-padid">{row.id}</code>
                <span className="omp-deck-padtitle" title={row.title}>
                  {row.title}
                </span>
                <span className="omp-deck-padstatus">{row.status}</span>
                <span className="omp-deck-padmeta">
                  gen {row.generation} · attempt {row.attempts}
                  {row.stageLabel ? ` · ${row.stageLabel}` : ""}
                  {row.lane === null ? "" : ` · L${row.lane}`}
                </span>
                <span className="omp-deck-padflags">
                  {row.live && <span className="omp-deck-padlive">{row.wedged ? "live · stalled" : "live"}</span>}
                  {row.alert !== null && <span className="omp-deck-padalert">{row.alert}</span>}
                  {row.ghost && <span>unknown dependency</span>}
                  {row.inCycle && <span>dependency cycle</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="omp-deck-flatworkers" aria-label="Workers">
        <WorkerLanes agents={agents} live={live} selected={selected} onSelect={onSelect} />
      </section>
    </div>
  );
}
