import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AgentRow, type RunDetail, type RunEvent, type RunSummary, type SliceDetail } from "./api.ts";
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
  const { runs, error: runsError } = useRuns();
  const [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [stats, setStats] = useState<Record<string, unknown> | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [sliceDetail, setSliceDetail] = useState<SliceDetail | Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const seqRef = useRef(-1);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

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
      const [d, ev, st, ag] = await Promise.all([
        api.run(id),
        api.events(id),
        api.stats(id),
        api.agents(id).catch((): AgentRow[] => []),
      ]);
      setDetail(d);
      setEvents(ev.events);
      seqRef.current = ev.offset;
      setStats(st);
      setAgents(ag);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

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
            setEvents((prev) => [...prev.slice(-400), ev]);
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
          setEvents((prev) => [...prev.slice(-400), ...ev.events]);
          await loadRun(runId);
        }
      } catch {
        /* offline tick — next poll retries */
      }
    }, POLL_MS);
    return () => {
      es?.close();
      clearInterval(poll);
    };
  }, [runId, loadRun]);

  useEffect(() => {
    if (!runId || !sel) {
      setSliceDetail(null);
      return;
    }
    api.slice(runId, sel).then(setSliceDetail).catch(() => setSliceDetail({ error: "slice not found" }));
  }, [runId, sel]);

  const selected = detail?.slices.find((s) => s.id === sel);

  const inspect = useCallback((sliceId: string) => {
    setSel(sliceId);
    setView((v) => (v === "overview" || v === "roadmap" ? v : "roadmap"));
  }, []);

  const openRun = useCallback((id: string) => {
    setRunId(id);
    setSel(null);
    setView("overview");
  }, []);

  return (
    <div className="omp-shell" data-sidebar={sidebarCollapsed ? "collapsed" : "open"}>
      <Header
        runs={runs}
        runId={runId}
        onSelectRun={openRun}
        live={detail?.live ?? false}
        version={version}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((c) => !c)}
      />
      <div className="omp-body">
        <Sidebar
          view={view}
          onNavigate={setView}
          counts={{
            overview: undefined,
            runs: runs.length || undefined,
            roadmap: detail?.slices.length,
            agents: agents.length || undefined,
            stats: undefined,
          }}
        />
        <main className="omp-main" aria-label={`${view} workspace`}>
          {stale && <p className="omp-warn">Bundle built against a different ompo version — rebuild the dashboard (`bun run web:build`).</p>}
          {(error ?? runsError) && <p className="omp-error" role="alert">{error ?? runsError}</p>}
          {view === "overview" && (
            <Overview detail={detail} events={events} selected={sel} onInspect={inspect} onNavigate={setView} />
          )}
          {view === "runs" && (
            <RunsPage runs={runs} activeRunId={runId} onOpen={openRun} />
          )}
          {view === "roadmap" && (
            <RoadmapPage detail={detail} selected={sel} onSelect={setSel} />
          )}
          {view === "agents" && (
            <AgentsPage agents={agents} live={detail?.live ?? false} />
          )}
          {view === "stats" && <StatsPage stats={stats} />}
        </main>
        <aside className="omp-inspector" aria-label="Inspector column">
          {runId && (
            <Inspector
              runId={runId}
              selected={selected}
              detail={sliceDetail}
              onClose={() => setSel(null)}
              onControlDone={() => void loadRun(runId)}
              slices={detail?.slices ?? []}
            />
          )}
        </aside>
      </div>
      <Activity events={events} />
    </div>
  );
}
