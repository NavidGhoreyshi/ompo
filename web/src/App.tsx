import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type AgentRow, type OperatorSession, type RunDetail, type RunEvent, type RunStats, type RunSummary, type SliceDetail } from "./api.ts";
import { instrument } from "./scene/instrument.ts";
import type { ReplayState } from "./scene/types.ts";
import { preferredSliceId } from "./lib/selection.ts";
import Activity from "./components/Activity.tsx";
import Header from "./components/Header.tsx";
import Inspector from "./components/Inspector.tsx";
import Sidebar, { type View } from "./components/Sidebar.tsx";
import AgentsPage from "./pages/AgentsPage.tsx";
import Overview from "./pages/Overview.tsx";
import RoadmapPage from "./pages/RoadmapPage.tsx";
import RunsPage from "./pages/RunsPage.tsx";
import StatsPage from "./pages/StatsPage.tsx";

const POLL_MS = 900;
/** The server's event page cap (`src/server.ts` `EVENTS_MAX_LIMIT`). */
const TIMELINE_PAGE = 2000;

/**
 * The temporal window (`d07`): the run's event log as the history layer
 * materializes it. The whole log when it fits in one page — every real run
 * measured so far does (96 events for a 22-slice run) — otherwise the newest
 * page, fetched with one extra request from `offset - page` rather than paging
 * through a log that may be orders of magnitude longer. Two requests worst
 * case, `TIMELINE_PAGE` events kept: the temporal layer's cost is bounded by
 * construction, and the bar states when the window is a tail.
 */
async function loadTimeline(id: string): Promise<{ events: RunEvent[]; truncated: boolean }> {
  const first = await api.events(id, -1, TIMELINE_PAGE);
  const newest = first.events[first.events.length - 1];
  if (newest === undefined) return { events: [], truncated: false };
  if (first.offset <= newest.seq) return { events: first.events, truncated: false };
  const tail = await api.events(id, Math.max(-1, first.offset - TIMELINE_PAGE), TIMELINE_PAGE);
  return tail.events.length > 0 ? { events: tail.events, truncated: true } : { events: first.events, truncated: true };
}

/** The deck is a lazy chunk; the shell loads it only when the surface asks. */
const Deck = lazy(() => import("./scene/Deck.tsx"));

type Surface = "dashboard" | "deck";

function initialSurface(): Surface {
  return new URLSearchParams(window.location.search).get("surface") === "deck" ? "deck" : "dashboard";
}

/**
 * A failed deck chunk (offline build, stale asset) must leave the operator a
 * usable shell: the boundary renders a card with the way back, and the
 * dashboard never unmounts because of it.
 */
class DeckBoundary extends Component<{ onExit: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("deck surface failed to load", error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="omp-deck-notice" role="alert">
        <p>The 3D surface failed to load — the dashboard is unaffected.</p>
        <button type="button" className="omp-deck-button" onClick={this.props.onExit}>
          Back to dashboard
        </button>
      </div>
    );
  }
}

function useRuns() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setRuns(await api.runs());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);
  return { runs, error, reload: load };
}

export default function App() {
  const [version, setVersion] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const { runs, error: runsError, reload: reloadRuns } = useRuns();
  const [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [sessions, setSessions] = useState<OperatorSession[]>([]);
  const [stats, setStats] = useState<RunStats | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [sliceDetail, setSliceDetail] = useState<SliceDetail | Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [surface, setSurface] = useState<Surface>(initialSurface);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // The temporal window (`d07`) — a bounded superset of `events`, kept apart
  // from it because they answer different questions: `events` is the live
  // window the feed and the inspector read, this is what history is derived
  // from. Appending keeps the window contiguous (`slice(-cap)`).
  const [timeline, setTimeline] = useState<{ events: RunEvent[]; truncated: boolean }>({ events: [], truncated: false });
  const [replay, setReplay] = useState<ReplayState | null>(null);
  // The Inspector is a contextual drawer, closed by default: the active
  // worker keeps the viewport until the operator asks for forensics.
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const seqRef = useRef(-1);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

  // The surface is a URL parameter so the desktop shell (`d11`) can address it;
  // replacing state keeps the dashboard's own history untouched.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (surface === "deck") url.searchParams.set("surface", "deck");
    else url.searchParams.delete("surface");
    window.history.replaceState(null, "", url);
  }, [surface]);

  useEffect(() => {
    api.health()
      .then((h) => {
        setVersion(h.version);
        const builtAgainst = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.["VITE_OMPO_VERSION"];
        setStale(!!builtAgainst && builtAgainst !== h.version);
      })
      .catch(() => setError("dashboard API unreachable — is the ompo server running?"));
  }, []);

  useEffect(() => {
    if (!runId && runs.length > 0) setRunId(runs[runs.length - 1]!.runId);
  }, [runs, runId]);

  const loadRun = useCallback(async (id: string) => {
    try {
      const [d, ev, st, ag, se] = await Promise.all([
        api.run(id),
        api.events(id),
        api.stats(id),
        api.agents(id).catch((): AgentRow[] => []),
        api.sessions(id).catch((): OperatorSession[] => []),
      ]);
      setDetail(d);
      setEvents(ev.events);
      for (const e of ev.events) instrument.noteEvent(e.seq, e.at);
      seqRef.current = ev.offset;
      setStats(st);
      setAgents(ag);
      setSessions(se);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  /** One new event into the temporal window, keeping it contiguous and capped. */
  const pushTimeline = useCallback((event: RunEvent) => {
    setTimeline((prev) => {
      const events = [...prev.events, event];
      return events.length > TIMELINE_PAGE
        ? { events: events.slice(-TIMELINE_PAGE), truncated: true }
        : { events, truncated: prev.truncated };
    });
  }, []);

  // The temporal window follows the run, not the SSE stream: one bounded fetch
  // per run switch (see `loadTimeline`), then appends. A switch cancels the
  // in-flight load so a slow answer cannot land on the next run's window.
  useEffect(() => {
    if (runId === null) {
      setTimeline({ events: [], truncated: false });
      setReplay(null);
      return;
    }
    let cancelled = false;
    setTimeline({ events: [], truncated: false });
    setReplay(null);
    loadTimeline(runId)
      .then((window) => {
        if (!cancelled) setTimeline(window);
      })
      .catch(() => {
        // The bar states "no events yet"; the run's own error banner already
        // tells the operator the API is unreachable.
        if (!cancelled) setTimeline({ events: [], truncated: false });
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  /** Verify replay on demand only (`d07`): the server's own comparison. */
  const verifyReplay = useCallback(() => {
    if (runId === null) return;
    setReplay({ status: "loading", events: 0, mismatches: [], error: null });
    api
      .replay(runId)
      .then((result) =>
        setReplay({ status: "ready", events: result.events, mismatches: result.mismatches, error: null }),
      )
      .catch((err) =>
        setReplay({ status: "error", events: 0, mismatches: [], error: err instanceof Error ? err.message : String(err) }),
      );
  }, [runId]);

  // Initial load + SSE live stream with polling fallback.
  useEffect(() => {
    if (!runId) return;
    void loadRun(runId);
    let es: EventSource | null = null;
    try {
      es = new EventSource(api.streamUrl(runId, seqRef.current));
      es.addEventListener("event", (m) => {
        try {
          const ev = JSON.parse((m as MessageEvent).data) as RunEvent;
          if (typeof ev.seq === "number" && ev.seq > seqRef.current) {
            seqRef.current = ev.seq;
            instrument.noteEvent(ev.seq, ev.at);
            setEvents((prev) => [...prev.slice(-400), ev]);
            pushTimeline(ev);
            // Targeted refresh: the frame only signals *what* changed — board/slice
            // state always re-derives from the read endpoints, never from the payload.
            void api.run(runId).then(setDetail).catch(() => {});
            if (typeof ev.sliceId === "string" && ev.sliceId === selRef.current) {
              void api.slice(runId, ev.sliceId).then(setSliceDetail).catch(() => {});
            }
          }
        } catch {
          /* ignore malformed frames */
        }
      });
      es.addEventListener("run", () => void loadRun(runId));
      es.onerror = () => {
        es?.close();
        es = null;
      };
    } catch {
      es = null;
    }
    const poll = setInterval(async () => {
      if (es) return; // SSE owns updates while connected
      try {
        const ev = await api.events(runId, seqRef.current);
        if (ev.events.length > 0) {
          seqRef.current = ev.offset;
          for (const e of ev.events) instrument.noteEvent(e.seq, e.at);
          setEvents((prev) => [...prev.slice(-400), ...ev.events]);
          for (const e of ev.events) pushTimeline(e);
          await loadRun(runId);
        }
      } catch {
        /* offline tick — next poll retries */
      }
    }, POLL_MS);
    // Operator sessions start/end without emitting run events (prompt + log
    // files only), so refresh the list on a slow tick regardless of SSE.
    const sessPoll = setInterval(() => {
      void api.sessions(runId).then(setSessions).catch(() => {});
    }, 10000);
    return () => {
      es?.close();
      clearInterval(poll);
      clearInterval(sessPoll);
    };
  }, [runId, loadRun, pushTimeline]);

  // Active slice auto-selection: a single selection system shared by the
  // board, lanes, graph, and Inspector. When nothing is selected (initial
  // load, run switch), the slice that needs eyes becomes the selection, so
  // the Inspector is never an empty rectangle while there is work to show.
  // Manual clicks always win — this only fills a null or stale selection.
  useEffect(() => {
    if (!detail || detail.slices.length === 0) return;
    if (!sel || !detail.slices.some((s) => s.id === sel)) {
      const id = preferredSliceId(detail.slices);
      if (id && id !== sel) setSel(id);
    }
  }, [detail, sel]);

  useEffect(() => {
    if (!runId || !sel) {
      setSliceDetail(null);
      return;
    }
    api.slice(runId, sel).then(setSliceDetail).catch(() => setSliceDetail({ error: "slice not found" }));
  }, [runId, sel]);

  const selected = detail?.slices.find((s) => s.id === sel);

  // Picking a slice is an explicit "show me this one": the drawer opens on
  // the same selection the board, lanes, and graph already share. The
  // auto-selection effect above never opens it.
  const inspect = useCallback((sliceId: string) => {
    setSel(sliceId);
    setInspectorOpen(true);
  }, []);

  const toggleSurface = useCallback(() => {
    setSurface((current) => (current === "deck" ? "dashboard" : "deck"));
  }, []);

  const openRun = useCallback((id: string) => {
    setRunId(id);
    setSel(null);
    setView("overview");
  }, []);

  // Resume settles through existing channels: the spawned loop takes the
  // lock (`live` flips) and appends `run_resumed` to the event tail. Reload
  // both lists so run markers and detail agree even before SSE lands it.
  const afterResume = useCallback((id: string) => {
    void reloadRuns();
    if (id === runId) void loadRun(id);
  }, [reloadRuns, runId, loadRun]);

  return (
    <div
      className="omp-shell"
      data-sidebar={sidebarCollapsed ? "collapsed" : "open"}
      data-inspector={inspectorOpen ? "open" : "closed"}
    >
      <Header
        runs={runs}
        runId={runId}
        onSelectRun={openRun}
        live={detail?.live ?? false}
        version={version}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
        inspectorOpen={inspectorOpen}
        onToggleInspector={() => setInspectorOpen((o) => !o)}
        selectedId={sel}
        surface={surface}
        onToggleSurface={toggleSurface}
      />
      <div className="omp-body">
        <Sidebar view={view} onNavigate={setView} runId={runId} />
        <main className="omp-main" aria-label={`${view} workspace`}>
          {stale && <p className="omp-warn">Bundle built against a different ompo version — rebuild the dashboard (`bun run web:build`).</p>}
          {(error ?? runsError) && <p className="omp-error" role="alert">{error ?? runsError}</p>}
          {surface === "deck" ? (
            <DeckBoundary onExit={toggleSurface}>
              <Suspense fallback={<div className="omp-deck-skeleton" role="status">loading the 3D surface…</div>}>
                <Deck
                  runId={runId}
                  detail={detail}
                  events={events}
                  timeline={timeline.events}
                  timelineTruncated={timeline.truncated}
                  runs={runs}
                  agents={agents}
                  selected={sel}
                  sliceDetail={sliceDetail}
                  live={detail?.live ?? false}
                  onSelect={setSel}
                  onOpenRun={openRun}
                  onControlDone={() => {
                    // The dock's control outcomes settle through the same
                    // channels the dashboard's inspector uses — the store's
                    // events and these two refetches. No deck-specific path.
                    if (runId === null) return;
                    void loadRun(runId);
                    void reloadRuns();
                  }}
                  replay={replay}
                  onVerifyReplay={verifyReplay}
                  onExit={toggleSurface}
                />
              </Suspense>
            </DeckBoundary>
          ) : (
            <>
          {view === "overview" && (
            <Overview
              detail={detail}
              events={events}
              agents={agents}
              sessions={sessions}
              selected={sel}
              onInspect={inspect}
              onOpenInspector={() => setInspectorOpen(true)}
            />
          )}
          {view === "runs" && (
            <RunsPage runs={runs} activeRunId={runId} onOpen={openRun} onResumed={afterResume} />
          )}
          {view === "roadmap" && (
            <RoadmapPage detail={detail} selected={sel} onSelect={setSel} />
          )}
          {view === "agents" && (
            <AgentsPage agents={agents} live={detail?.live ?? false} selected={sel} onSelect={setSel} />
          )}
          {view === "stats" && <StatsPage stats={stats} runId={runId} />}
            </>
          )}
        </main>
        <aside
          className="omp-inspector"
          id="omp-inspector"
          aria-label="Inspector"
          aria-hidden={inspectorOpen ? undefined : "true"}
          inert={!inspectorOpen}
        >
          {runId && (
            <Inspector
              runId={runId}
              selected={selected}
              detail={sliceDetail}
              onControlDone={() => { void loadRun(runId); void reloadRuns(); }}
              onClose={() => setInspectorOpen(false)}
              slices={detail?.slices ?? []}
              events={events}
              live={detail?.live}
              wedged={selected ? agents.find((a) => a.id === selected.id)?.wedged : undefined}
            />
          )}
        </aside>
      </div>
      <Activity events={events} live={detail?.live} />
    </div>
  );
}
