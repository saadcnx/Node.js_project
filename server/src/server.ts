import express, { NextFunction, Request, Response, Router } from 'express';
import cors from 'cors';
import { Worker } from 'worker_threads';
import { randomUUID } from 'crypto';
import { applyScenario, Graph, initialGraph, initialState, Patch, Scenario, SystemState } from './patches';

type Level = 'info' | 'warn' | 'error' | 'success';
interface LogEvent {
  id: string;
  ts: number;
  level: Level;
  source: string;
  msg: string;
}
interface Query {
  engine: string;
  statement: string;
  ms: number;
}

const SCENARIOS: Scenario[] = ['add-endpoint', 'switch-orm', 'switch-auth', 'add-go-service'];
const app = express();
app.use(cors({ origin: true, exposedHeaders: ['x-zc-orm', 'x-zc-cache', 'x-response-time', 'x-auth-strategy', 'x-zc-upstream'] }));
app.use(express.json());

let state: SystemState = initialState();
let graph: Graph = initialGraph();
let lastPatch: Patch | null = null;
let dyn: Router = express.Router();
let busy = false;
const history: LogEvent[] = [];
const clients = new Set<Response>();
const cache = new Map<string, number>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => Math.round((a + Math.random() * (b - a)) * 10) / 10;

function emit(level: Level, source: string, msg: string) {
  const e: LogEvent = { id: randomUUID(), ts: Date.now(), level, source, msg };
  history.push(e);
  if (history.length > 300) history.shift();
  const payload = `data: ${JSON.stringify(e)}\n\n`;
  clients.forEach((c) => c.write(payload));
}

function runWorker(label: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const t = Date.now();
    const w = new Worker(
      "const { parentPort, workerData } = require('worker_threads');let s = 0;for (let i = 0; i < 3e6; i++) s += i % 7;parentPort.postMessage({ label: workerData.label, s });",
      { eval: true, workerData: { label } },
    );
    w.once('message', () => resolve(Date.now() - t));
    w.once('error', reject);
  });
}

function authMw(req: Request, res: Response, next: NextFunction) {
  const h = req.header('authorization') ?? '';
  const ok = state.auth === 'jwt' ? h.startsWith('Bearer zc.jwt.') : h.startsWith('Bearer oidc.');
  res.setHeader('x-auth-strategy', state.auth);
  if (!ok) {
    emit('warn', 'auth', `401 ${req.method} ${req.originalUrl} (${state.auth} verification failed)`);
    res.status(401).json({ error: 'unauthorized', strategy: state.auth });
    return;
  }
  emit('info', 'auth', `${state.auth} token verified for ${req.originalUrl}`);
  next();
}

function makeHandler(name: string) {
  return async (req: Request, res: Response) => {
    const t0 = process.hrtime.bigint();
    const queries: Query[] = [];
    const key = `${state.orm}:${name}`;
    const stamp = cache.get(key);
    const hit = stamp !== undefined && Date.now() - stamp < 30000;
    if (hit) {
      const ms = rand(0.4, 1.6);
      await sleep(ms);
      queries.push({ engine: 'redis', statement: `GET zc:${name}`, ms });
    } else {
      const m1 = rand(0.5, 1.8);
      await sleep(m1);
      queries.push({ engine: 'redis', statement: `GET zc:${name} -> nil`, ms: m1 });
      const m2 = state.orm === 'prisma' ? rand(9, 26) : rand(5, 17);
      await sleep(m2);
      queries.push({
        engine: `${state.orm}/postgresql`,
        statement: `SELECT * FROM "${name}" LIMIT 20`,
        ms: m2,
      });
      const m3 = rand(0.6, 2);
      await sleep(m3);
      queries.push({ engine: 'redis', statement: `SETEX zc:${name} 30`, ms: m3 });
      cache.set(key, Date.now());
    }
    const total = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 10) / 10;
    res.setHeader('x-zc-orm', state.orm);
    res.setHeader('x-zc-cache', hit ? 'HIT' : 'MISS');
    res.setHeader('x-response-time', `${total}ms`);
    emit('success', 'express', `GET ${req.originalUrl} 200 ${total}ms cache=${hit ? 'HIT' : 'MISS'} orm=${state.orm}`);
    res.json({
      data: {
        route: name,
        items: Array.from({ length: 3 }, (_, i) => ({ id: i + 1, name: `${name}-${i + 1}`, createdAt: new Date().toISOString() })),
      },
      meta: { orm: state.orm, auth: state.auth, cache: hit ? 'HIT' : 'MISS', queries, totalMs: total },
    });
  };
}

async function pricingHandler(req: Request, res: Response) {
  const ms = rand(3, 11);
  emit('info', 'gateway', 'proxy -> pricing:8081/quote');
  await sleep(ms);
  res.setHeader('x-zc-upstream', 'go-pricing:8081');
  res.setHeader('x-zc-orm', state.orm);
  res.setHeader('x-zc-cache', 'MISS');
  res.setHeader('x-response-time', `${ms}ms`);
  emit('success', 'go-pricing', `GET /quote 200 ${ms}ms`);
  res.json({
    data: { sku: 'ZC-100', price: 49.9, currency: 'USD' },
    meta: {
      orm: state.orm,
      auth: state.auth,
      cache: 'MISS',
      upstream: 'go-pricing:8081',
      queries: [{ engine: 'http/go', statement: 'GET /quote', ms }],
      totalMs: ms,
    },
  });
}

function registerRoute(name: string) {
  dyn.get(`/${name}`, name === 'go-pricing' ? pricingHandler : makeHandler(name));
  emit('success', 'router', `router.get('/api/dyn/${name}') registered at runtime`);
}

app.use('/api/dyn', authMw, (req, res, next) => dyn(req, res, next));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/api/state', (_req, res) => {
  res.json({ state, graph, patch: lastPatch });
});

app.get('/api/zc/mock-patch/:scenario', (req, res) => {
  const sc = req.params.scenario as Scenario;
  if (!SCENARIOS.includes(sc)) {
    res.status(400).json({ error: 'unknown scenario' });
    return;
  }
  const param = typeof req.query.param === 'string' ? req.query.param : undefined;
  res.json(applyScenario(state, graph, sc, param).patch);
});

app.get('/api/logs/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  history.forEach((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
});

app.post('/api/zc/apply', async (req, res) => {
  const { scenario, param } = req.body as { scenario: Scenario; param?: string };
  if (!SCENARIOS.includes(scenario)) {
    res.status(400).json({ error: 'unknown scenario' });
    return;
  }
  if (busy) {
    res.status(409).json({ error: 'agent busy' });
    return;
  }
  busy = true;
  try {
    emit('info', 'zerocommit', `agent plan received: ${scenario}${param ? ` (${param})` : ''}`);
    const result = applyScenario(state, graph, scenario, param);
    const steps = ['parsing AST (ts-morph)', 'building dependency graph', 'generating multi-file patch', 'validating go.mod and Dockerfile'];
    for (const step of steps) {
      emit('info', 'zerocommit', step);
      await sleep(220);
    }
    emit('info', 'worker#1', 'spawned worker thread: tsc --noEmit');
    emit('info', 'worker#2', 'spawned worker thread: go build ./...');
    const [a, b] = await Promise.all([runWorker('tsc'), runWorker('go')]);
    emit('success', 'worker#1', `tsc --noEmit ok in ${a}ms`);
    emit('success', 'worker#2', `go build ./... ok in ${b}ms`);
    state = result.state;
    graph = result.graph;
    lastPatch = result.patch;
    if (scenario !== 'add-endpoint') cache.clear();
    if (result.addedRoute) registerRoute(result.addedRoute);
    emit('success', 'zerocommit', `patch ${result.patch.id} applied: ${result.patch.files.length} files, graph nodes=${graph.nodes.length}`);
    res.json({ state, graph, patch: result.patch, addedRoute: result.addedRoute });
  } catch (err) {
    emit('error', 'zerocommit', `apply failed: ${(err as Error).message}`);
    res.status(500).json({ error: 'apply failed' });
  } finally {
    busy = false;
  }
});

app.post('/api/zc/reset', (_req, res) => {
  state = initialState();
  graph = initialGraph();
  lastPatch = null;
  dyn = express.Router();
  cache.clear();
  emit('warn', 'zerocommit', 'workspace reset to baseline');
  res.json({ state, graph, patch: null });
});

const PORT = Number(process.env.PORT ?? 4000);
app.listen(PORT, () => {
  emit('info', 'node', `process ${process.pid} booting (node ${process.version})`);
  emit('info', 'node', 'express compiled routes: /api/state, /api/zc/*, /api/logs/stream');
  emit('success', 'node', `listening on http://localhost:${PORT}`);
  console.log(`Zero Commit demo server on :${PORT}`);
});