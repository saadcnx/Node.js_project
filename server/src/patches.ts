export type NodeKind = 'client' | 'gateway' | 'auth' | 'route' | 'service' | 'orm' | 'db' | 'cache';
export type NodeStatus = 'stable' | 'new' | 'modified';
export type Scenario = 'add-endpoint' | 'switch-orm' | 'switch-auth' | 'add-go-service';

export interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  status: NodeStatus;
  file?: string;
}
export interface GraphEdge {
  from: string;
  to: string;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
export interface DiffLine {
  t: 'add' | 'del' | 'ctx';
  s: string;
}
export interface FilePatch {
  path: string;
  language: string;
  hunk: string;
  lines: DiffLine[];
}
export interface SystemState {
  orm: 'prisma' | 'drizzle';
  auth: 'jwt' | 'oidc';
  goService: boolean;
  routes: string[];
}
export interface Patch {
  id: string;
  scenario: Scenario;
  title: string;
  summary: string;
  files: FilePatch[];
  graph: Graph;
}
export interface ApplyResult {
  state: SystemState;
  graph: Graph;
  patch: Patch;
  addedRoute?: string;
}

const parse = (raw: string[]): DiffLine[] =>
  raw.map((l) => {
    const c = l.charAt(0);
    return { t: c === '+' ? 'add' : c === '-' ? 'del' : 'ctx', s: l.slice(1) };
  });

const fp = (path: string, language: string, hunk: string, raw: string[]): FilePatch => ({
  path,
  language,
  hunk,
  lines: parse(raw),
});

const pascal = (n: string) =>
  n
    .split('-')
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('');
const camel = (n: string) => {
  const p = pascal(n);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

const ORM = {
  prisma: {
    label: 'Prisma Client',
    imp: "import { PrismaClient } from '@prisma/client';",
    init: 'const db = new PrismaClient();',
    gen: 'RUN npx prisma generate',
    pg: 'github.com/lib/pq v1.10.9',
    gi: '_ "github.com/lib/pq"',
  },
  drizzle: {
    label: 'Drizzle ORM',
    imp: "import { drizzle } from 'drizzle-orm/node-postgres';",
    init: 'const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }));',
    gen: 'RUN npx drizzle-kit generate',
    pg: 'github.com/jackc/pgx/v5 v5.6.0',
    gi: '_ "github.com/jackc/pgx/v5/stdlib"',
  },
};

const AUTH = {
  jwt: {
    label: 'JWT Middleware',
    imp: 'import { requireJwt } ' + "from './auth/jwt.js';",
    use: "app.use('/api/dyn', requireJwt(process.env.JWT_SECRET!));",
    go: 'claims, err := verifyJWT(r.Header.Get("Authorization"))',
    mod: 'github.com/golang-jwt/jwt/v5 v5.2.1',
    env: 'ENV AUTH_STRATEGY=jwt',
  },
  oidc: {
    label: 'OIDC Provider',
    imp: "import { auth } from 'express-openid-connect';",
    use: "app.use('/api/dyn', auth({ issuerBaseURL: process.env.OIDC_ISSUER, clientID: process.env.OIDC_CLIENT_ID }));",
    go: 'claims, err := verifyOIDC(r.Context(), r.Header.Get("Authorization"))',
    mod: 'github.com/coreos/go-oidc/v3 v3.11.0',
    env: 'ENV AUTH_STRATEGY=oidc',
  },
};

export const initialState = (): SystemState => ({ orm: 'prisma', auth: 'jwt', goService: false, routes: [] });

export const initialGraph = (): Graph => ({
  nodes: [
    { id: 'client', label: 'Client', kind: 'client', status: 'stable' },
    { id: 'gateway', label: 'Express Gateway', kind: 'gateway', status: 'stable', file: 'server.ts' },
    { id: 'auth', label: 'JWT Middleware', kind: 'auth', status: 'stable', file: 'server.ts' },
    { id: 'orm', label: 'Prisma Client', kind: 'orm', status: 'stable', file: 'server.ts' },
    { id: 'db', label: 'PostgreSQL', kind: 'db', status: 'stable' },
    { id: 'cache', label: 'Redis Cache', kind: 'cache', status: 'stable' },
  ],
  edges: [
    { from: 'client', to: 'gateway' },
    { from: 'gateway', to: 'auth' },
    { from: 'auth', to: 'orm' },
    { from: 'orm', to: 'db' },
  ],
});

const goMod = (extra: string[]): string[] => [' module zerocommit/gateway-sidecar', ' ', ' go 1.22', ' ', ...extra];

export function applyScenario(state: SystemState, graph: Graph, scenario: Scenario, param?: string): ApplyResult {
  const s: SystemState = structuredClone(state);
  const g: Graph = structuredClone(graph);
  g.nodes.forEach((n) => (n.status = 'stable'));
  const id = `zc-${Date.now().toString(36)}`;
  let files: FilePatch[] = [];
  let title = '';
  let summary = '';
  let addedRoute: string | undefined;

  if (scenario === 'add-endpoint') {
    let name = (param ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '') || 'orders';
    if (s.routes.includes(name)) name = `${name}-${s.routes.length + 1}`;
    addedRoute = name;
    s.routes.push(name);
    const q =
      s.orm === 'prisma'
        ? `  const rows = await db.${camel(name)}.findMany({ take: 20 });`
        : `  const rows = await db.select().from(${camel(name)}).limit(20);`;
    const env = `ENV ZC_ROUTE_${name.toUpperCase().replace(/-/g, '_')}=enabled`;
    g.nodes.push({ id: `route:${name}`, label: `/${name}`, kind: 'route', status: 'new', file: 'server.ts' });
    g.edges.push(
      { from: 'auth', to: `route:${name}` },
      { from: `route:${name}`, to: 'orm' },
      { from: `route:${name}`, to: 'cache' },
    );
    title = `Add dynamic endpoint /api/dyn/${name}`;
    summary = `Registers GET /${name} with Redis read-through cache and ${s.orm} query across Node, Go sidecar and Docker env.`;
    files = [
      fp('server.ts', 'typescript', '@@ -58,6 +58,11 @@', [
        ' const dyn = express.Router();',
        ' ',
        `+dyn.get('/${name}', cached('${name}', async () => {`,
        `+${q}`,
        '+  return { items: rows };',
        '+}));',
        ' ',
        " app.use('/api/dyn', authMw, dyn);",
      ]),
      fp('main.go', 'go', '@@ -21,4 +21,8 @@', [
        ' func registerRoutes(mux *http.ServeMux) {',
        `+\tmux.HandleFunc("/internal/${name}/health", func(w http.ResponseWriter, r *http.Request) {`,
        `+\t\tjson.NewEncoder(w).Encode(map[string]string{"route": "${name}", "status": "ok"})`,
        '+\t})',
        ' }',
      ]),
      fp('go.mod', 'go', '@@ -1,5 +1,5 @@', goMod(['\t' + ORM[s.orm].pg])),
      fp('Dockerfile', 'dockerfile', '@@ -9,4 +9,5 @@', [
        ' COPY . .',
        `+${env}`,
        ' EXPOSE 4000',
        ' CMD ["node", "dist/server.js"]',
      ]),
    ];
  }

  if (scenario === 'switch-orm') {
    const from = s.orm;
    const to: 'prisma' | 'drizzle' = param === 'drizzle' || param === 'prisma' ? param : from === 'prisma' ? 'drizzle' : 'prisma';
    s.orm = to;
    const n = g.nodes.find((x) => x.id === 'orm');
    if (n) {
      n.label = ORM[to].label;
      n.status = 'modified';
    }
    title = `Switch ORM ${from} → ${to}`;
    summary = `Rewrites client init, Go driver, module requirements and the build step for ${to}.`;
    files = [
      fp('server.ts', 'typescript', '@@ -1,8 +1,9 @@', [
        " import express from 'express';",
        `-${ORM[from].imp}`,
        `+${ORM[to].imp}`,
        ...(to === 'drizzle' ? ["+import { Pool } from 'pg';"] : []),
        ' ',
        `-${ORM[from].init}`,
        `+${ORM[to].init}`,
      ]),
      fp('main.go', 'go', '@@ -3,7 +3,7 @@', [
        ' import (',
        '\t"database/sql"',
        `-\t${ORM[from].gi}`,
        `+\t${ORM[to].gi}`,
        ' )',
      ]),
      fp('go.mod', 'go', '@@ -3,6 +3,6 @@', [
        ' module zerocommit/gateway-sidecar',
        ' ',
        ' require (',
        `-\t${ORM[from].pg}`,
        `+\t${ORM[to].pg}`,
        ' )',
      ]),
      fp('Dockerfile', 'dockerfile', '@@ -5,5 +5,5 @@', [
        ' RUN npm ci',
        `-${ORM[from].gen}`,
        `+${ORM[to].gen}`,
        ' RUN npm run build',
      ]),
    ];
  }

  if (scenario === 'switch-auth') {
    const from = s.auth;
    const to: 'jwt' | 'oidc' = param === 'jwt' || param === 'oidc' ? param : from === 'jwt' ? 'oidc' : 'jwt';
    s.auth = to;
    const n = g.nodes.find((x) => x.id === 'auth');
    if (n) {
      n.label = AUTH[to].label;
      n.status = 'modified';
    }
    title = `Modify auth pipeline ${from.toUpperCase()} → ${to.toUpperCase()}`;
    summary = `Swaps the gateway middleware, Go token verifier, dependency and AUTH_STRATEGY env.`;
    files = [
      fp('server.ts', 'typescript', '@@ -12,7 +12,7 @@', [
        `-${AUTH[from].imp}`,
        `+${AUTH[to].imp}`,
        ' ',
        `-${AUTH[from].use}`,
        `+${AUTH[to].use}`,
      ]),
      fp('main.go', 'go', '@@ -34,6 +34,6 @@', [
        ' func guard(next http.Handler) http.Handler {',
        ' \treturn http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {',
        `-\t\t${AUTH[from].go}`,
        `+\t\t${AUTH[to].go}`,
        ' \t\tif err != nil {',
      ]),
      fp('go.mod', 'go', '@@ -5,5 +5,5 @@', [
        ' require (',
        `-\t${AUTH[from].mod}`,
        `+\t${AUTH[to].mod}`,
        ' )',
      ]),
      fp('Dockerfile', 'dockerfile', '@@ -11,3 +11,3 @@', [
        ' EXPOSE 4000',
        `-${AUTH[from].env}`,
        `+${AUTH[to].env}`,
        ' CMD ["node", "dist/server.js"]',
      ]),
    ];
  }

  if (scenario === 'add-go-service') {
    if (!s.goService) {
      s.goService = true;
      addedRoute = 'go-pricing';
      s.routes.push('go-pricing');
      g.nodes.push({ id: 'go-svc', label: 'Go Pricing Service', kind: 'service', status: 'new', file: 'main.go' });
      g.edges.push({ from: 'gateway', to: 'go-svc' }, { from: 'go-svc', to: 'db' });
    }
    title = 'Add Go microservice routing (pricing)';
    summary = 'Adds a Go pricing service, proxies /go-pricing through the gateway and builds it in a multi-stage Dockerfile.';
    files = [
      fp('server.ts', 'typescript', '@@ -3,6 +3,8 @@', [
        " import cors from 'cors';",
        "+import { createProxyMiddleware } from 'http-proxy-middleware';",
        ' const dyn = express.Router();',
        ' ',
        "+dyn.use('/go-pricing', createProxyMiddleware({ target: process.env.GO_PRICING_URL ?? 'http://pricing:8081', changeOrigin: true }));",
      ]),
      fp('main.go', 'go', '@@ -0,0 +1,13 @@', [
        '+package main',
        '+',
        '+import (',
        '+\t"encoding/json"',
        '+\t"net/http"',
        '+)',
        '+',
        '+func main() {',
        '+\thttp.HandleFunc("/quote", func(w http.ResponseWriter, r *http.Request) {',
        '+\t\tjson.NewEncoder(w).Encode(map[string]any{"sku": "ZC-100", "price": 49.9})',
        '+\t})',
        '+\thttp.ListenAndServe(":8081", nil)',
        '+}',
      ]),
      fp('go.mod', 'go', '@@ -0,0 +1,3 @@', ['+module zerocommit/pricing', '+', '+go 1.22']),
      fp('Dockerfile', 'dockerfile', '@@ -1,6 +1,12 @@', [
        '+FROM golang:1.22-alpine AS pricing-build',
        '+WORKDIR /svc',
        '+COPY services/pricing/ .',
        '+RUN go build -o /pricing .',
        '+',
        ' FROM node:20-alpine',
        ' COPY --from=build /app/dist ./dist',
        '+COPY --from=pricing-build /pricing /usr/local/bin/pricing',
      ]),
    ];
  }

  const patch: Patch = { id, scenario, title, summary, files, graph: g };
  return { state: s, graph: g, patch, addedRoute };
}