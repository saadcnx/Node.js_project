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
export interface LogEvent {
  id: string;
  ts: number;
  level: 'info' | 'warn' | 'error' | 'success';
  source: string;
  msg: string;
}
export interface QueryTiming {
  engine: string;
  statement: string;
  ms: number;
}
export interface ProbeResult {
  request: { method: string; url: string; headers: Record<string, string> };
  response: { status: number; headers: Record<string, string>; body: unknown; ms: number };
  queries: QueryTiming[];
}