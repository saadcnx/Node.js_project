'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FilePatch, Graph, LogEvent, NodeKind, Patch, ProbeResult, QueryTiming, Scenario, SystemState } from '../lib/types';

const API = '';
const COL: Record<NodeKind, number> = { client: 0, gateway: 1, auth: 2, route: 3, service: 3, orm: 4, db: 5, cache: 5 };
const NW = 128;
const NH = 40;
const GX = 156;
const GY = 62;

function layout(g: Graph) {
  const rows: Record<number, number> = {};
  const pos: Record<string, { x: number; y: number }> = {};
  g.nodes.forEach((n) => {
    const c = COL[n.kind];
    const r = rows[c] ?? 0;
    rows[c] = r + 1;
    pos[n.id] = { x: c * GX + 12, y: r * GY + 16 };
  });
  const h = Math.max(1, ...Object.values(rows)) * GY + 16;
  return { pos, h };
}

function GraphView({ graph }: { graph: Graph }) {
  const { pos, h } = useMemo(() => layout(graph), [graph]);
  return (
    <svg viewBox={`0 0 ${6 * GX} ${h}`} className="graph">
      {graph.edges.map((e) => {
        const a = pos[e.from];
        const b = pos[e.to];
        if (!a || !b) return null;
        const x1 = a.x + NW;
        const y1 = a.y + NH / 2;
        const x2 = b.x;
        const y2 = b.y + NH / 2;
        const mx = (x1 + x2) / 2;
        return <path key={`${e.from}>${e.to}`} className="edge" d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} />;
      })}
      {graph.nodes.map((n) => {
        const p = pos[n.id];
        return (
          <g key={n.id} className={`gnode ${n.status}`} style={{ transform: `translate(${p.x}px, ${p.y}px)` }}>
            <rect width={NW} height={NH} rx={8} />
            <text x={NW / 2} y={NH / 2 + 4} textAnchor="middle">
              {n.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function DiffView({ file }: { file: FilePatch }) {
  return (
    <div className="diff">
      <div className="hunk">
        {file.path} · {file.language} · {file.hunk}
      </div>
      {file.lines.map((l, i) => (
        <div key={i} className={`dl ${l.t}`}>
          <span>{l.t === 'add' ? '+' : l.t === 'del' ? '-' : ' '}</span>
          <span>{l.s}</span>
        </div>
      ))}
    </div>
  );
}

const time = (ts: number) => new Date(ts).toLocaleTimeString('en-GB');

export default function Workspace() {
  const [sys, setSys] = useState<SystemState | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [patch, setPatch] = useState<Patch | null>(null);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [online, setOnline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('orders');
  const [target, setTarget] = useState('');
  const [tab, setTab] = useState(0);
  const [probeRes, setProbeRes] = useState<ProbeResult | null>(null);
  const [showJson, setShowJson] = useState(false);
  const seen = useRef(new Set<string>());
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${API}/api/state`)
      .then((r) => r.json())
      .then((d) => {
        setSys(d.state);
        setGraph(d.graph);
        setPatch(d.patch);
        if (d.state.routes.length) setTarget(d.state.routes[d.state.routes.length - 1]);
        setOnline(true);
      })
      .catch(() => setOnline(false));
  }, []);

  useEffect(() => {
    const es = new EventSource(`${API}/api/logs/stream`);
    es.onopen = () => setOnline(true);
    es.onerror = () => setOnline(false);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as LogEvent;
      if (seen.current.has(e.id)) return;
      seen.current.add(e.id);
      setLogs((l) => [...l.slice(-499), e]);
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const probe = useCallback(async (path: string, auth: 'jwt' | 'oidc', bad = false) => {
    const token = bad ? 'invalid.token' : auth === 'jwt' ? 'zc.jwt.demo' : 'oidc.zc.demo';
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'X-Request-Id': Math.random().toString(16).slice(2, 10),
    };
    const url = `${API}/api/dyn/${path}`;
    const t0 = performance.now();
    try {
      const r = await fetch(url, { headers });
      const body = await r.json();
      const ms = Math.round((performance.now() - t0) * 10) / 10;
      const rh: Record<string, string> = {};
      r.headers.forEach((v, k) => (rh[k] = v));
      const queries: QueryTiming[] = (body as { meta?: { queries?: QueryTiming[] } })?.meta?.queries ?? [];
      setProbeRes({
        request: { method: 'GET', url: `/api/dyn/${path}`, headers },
        response: { status: r.status, headers: rh, body, ms },
        queries,
      });
    } catch {
      setOnline(false);
    }
  }, []);

  const apply = useCallback(
    async (scenario: Scenario, param?: string) => {
      setBusy(true);
      try {
        const r = await fetch(`${API}/api/zc/apply`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario, param }),
        });
        if (!r.ok) return;
        const d = await r.json();
        setSys(d.state);
        setGraph(d.graph);
        setPatch(d.patch);
        setTab(0);
        if (d.addedRoute) {
          setTarget(d.addedRoute);
          await probe(d.addedRoute, d.state.auth);
        } else if (target) {
          await probe(target, d.state.auth);
        }
      } catch {
        setOnline(false);
      } finally {
        setBusy(false);
      }
    },
    [probe, target],
  );

  const reset = async () => {
    setBusy(true);
    try {
      const r = await fetch(`${API}/api/zc/reset`, { method: 'POST' });
      const d = await r.json();
      setSys(d.state);
      setGraph(d.graph);
      setPatch(null);
      setProbeRes(null);
      setTarget('');
    } finally {
      setBusy(false);
    }
  };

  const maxMs = Math.max(1, ...(probeRes?.queries.map((q) => q.ms) ?? [1]));
  const file = patch?.files[tab];

  return (
    <div className="ws">
      <header className="top">
        <div className="brand">
          Zero<span>Commit</span> · Live Workspace
        </div>
        <span className={`pill ${online ? 'on' : 'off'}`}>{online ? 'backend connected' : 'backend offline'}</span>
      </header>
      {!online && <div className="banner">Cannot reach backend API. Check: docker compose ps and docker compose logs server</div>}
      <div className="cols">
        <section className="col">
          <div className="card">
            <h3>System Controls</h3>
            <div className="row">
              <span className="lbl">Endpoint</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="route name, e.g. orders" />
              <button className="primary" disabled={busy || !online} onClick={() => apply('add-endpoint', name)}>
                Add endpoint
              </button>
            </div>
            <div className="row">
              <span className="lbl">ORM</span>
              {(['prisma', 'drizzle'] as const).map((o) => (
                <button key={o} className={sys?.orm === o ? 'active' : ''} disabled={busy || !online || sys?.orm === o} onClick={() => apply('switch-orm', o)}>
                  {o}
                </button>
              ))}
            </div>
            <div className="row">
              <span className="lbl">Auth</span>
              {(['jwt', 'oidc'] as const).map((a) => (
                <button key={a} className={sys?.auth === a ? 'active' : ''} disabled={busy || !online || sys?.auth === a} onClick={() => apply('switch-auth', a)}>
                  {a === 'jwt' ? 'JWT' : 'OAuth2 / OIDC'}
                </button>
              ))}
            </div>
            <div className="row">
              <span className="lbl">Services</span>
              <button disabled={busy || !online || !!sys?.goService} onClick={() => apply('add-go-service')}>
                {sys?.goService ? 'Go pricing service active' : 'Add Go microservice'}
              </button>
              <button className="danger" disabled={busy || !online} onClick={reset}>
                Reset
              </button>
            </div>
          </div>

          <div className="card">
            <h3>
              DeepMap Visualizer
              <button onClick={() => setShowJson((v) => !v)}>{showJson ? 'Show graph' : 'Show JSON'}</button>
            </h3>
            {graph && !showJson && <GraphView graph={graph} />}
            {graph && showJson && <pre className="json">{JSON.stringify(graph, null, 2)}</pre>}
            <p className="note" style={{ marginTop: 10 }}>
              Green = new node, amber = modified. Nodes: {graph?.nodes.length ?? 0} · Edges: {graph?.edges.length ?? 0}
            </p>
          </div>

          {patch && (
            <div className="card">
              <h3>Last Patch · {patch.id}</h3>
              <p className="note">
                <b>{patch.title}</b>
                <br />
                {patch.summary}
              </p>
            </div>
          )}
        </section>

        <section className="col">
          <div className="card">
            <h3>Live Terminal</h3>
            <div className="term" ref={termRef}>
              {logs.map((l) => (
                <div key={l.id}>
                  <span className="t-ts">{time(l.ts)} </span>
                  <span className="t-src">[{l.source}] </span>
                  <span className={`t-${l.level}`}>{l.msg}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <h3>Payload and API Inspector</h3>
            <div className="row">
              <select value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">select route</option>
                {sys?.routes.map((r) => (
                  <option key={r} value={r}>
                    /api/dyn/{r}
                  </option>
                ))}
              </select>
              <button disabled={!target || !sys} onClick={() => sys && probe(target, sys.auth)}>
                Send request
              </button>
              <button disabled={!target || !sys} onClick={() => sys && probe(target, sys.auth, true)}>
                Send invalid token
              </button>
            </div>
            {!probeRes && <p className="note">No request yet. Add an endpoint, then send a request.</p>}
            {probeRes && (
              <>
                <div className="row">
                  <span className={`badge ${probeRes.response.status < 400 ? 's2' : 's4'}`}>{probeRes.response.status}</span>
                  <span className="note" style={{ margin: 0 }}>
                    {probeRes.request.method} {probeRes.request.url} · round trip {probeRes.response.ms}ms · cache {probeRes.response.headers['x-zc-cache'] ?? 'n/a'}
                  </span>
                </div>
                <div className="grid2">
                  <div>
                    <div className="sub">Request headers</div>
                    <pre className="json">{JSON.stringify(probeRes.request.headers, null, 2)}</pre>
                  </div>
                  <div>
                    <div className="sub">Response headers</div>
                    <pre className="json">{JSON.stringify(probeRes.response.headers, null, 2)}</pre>
                  </div>
                </div>
                <div className="sub" style={{ marginTop: 10 }}>
                  Raw JSON payload
                </div>
                <pre className="json">{JSON.stringify(probeRes.response.body, null, 2)}</pre>
                <div className="sub" style={{ marginTop: 10 }}>
                  Query execution timings
                </div>
                {probeRes.queries.length === 0 && <p className="note">No queries executed (request rejected).</p>}
                {probeRes.queries.map((q, i) => (
                  <div className="qrow" key={i} title={q.statement}>
                    <span>{q.engine}</span>
                    <div className="bar" style={{ width: `${Math.max(2, (q.ms / maxMs) * 100)}%` }} />
                    <span>{q.ms}ms</span>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="card">
            <h3>Multi-Language Runtime Simulator</h3>
            {!patch && <p className="note">Trigger a change on the left to see Zero Commit patch server.ts, main.go, go.mod and Dockerfile together.</p>}
            {patch && (
              <>
                <div className="tabs">
                  {patch.files.map((f, i) => (
                    <button key={f.path} className={tab === i ? 'active' : ''} onClick={() => setTab(i)}>
                      {f.path}
                    </button>
                  ))}
                </div>
                {file && <DiffView file={file} />}
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}