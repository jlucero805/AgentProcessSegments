import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import {
  canTransition,
  type AgentStatus,
  type Effort,
  type Request,
  type State,
} from '../domain/request.js';

export type RequestErrorCode = 'NOT_FOUND' | 'ILLEGAL_TRANSITION';

export class RequestError extends Error {
  constructor(
    readonly code: RequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

export interface CreateInput {
  title: string;
  body?: string | undefined;
  targetRepo?: string | null | undefined;
  cellId?: string | null | undefined;
}

/** Mirrors the PATCH body in the HTTP API. Undefined means "leave alone". */
export interface EditInput {
  title?: string | undefined;
  body?: string | undefined;
  targetRepo?: string | null | undefined;
  acceptanceCriteria?: string | null | undefined;
  context?: string | null | undefined;
  skills?: string[] | undefined;
  groomed?: boolean | undefined;
  model?: string | null | undefined;
  effort?: Effort | null | undefined;
  kbDigest?: boolean | undefined;
  digest?: string | null | undefined;
  cellId?: string | null | undefined;
}

export interface ListFilter {
  state?: State | undefined;
  cellId?: string | null | undefined;
  view?: 'intake' | undefined;
}

interface RequestRow {
  id: string;
  title: string;
  body: string;
  state: State;
  groomed: number;
  clarify_started: number;
  model: string | null;
  effort: Effort | null;
  target_repo: string | null;
  acceptance_criteria: string | null;
  context: string | null;
  skills: string;
  kb_digest: number;
  digest: string | null;
  agent_status: AgentStatus;
  unchecked: number;
  hc_run_ids: string;
  branch: string | null;
  cr_url: string | null;
  cell_id: string | null;
  created_at: number;
  updated_at: number;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toRequest(row: RequestRow): Request {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    state: row.state,
    groomed: row.groomed === 1,
    clarifyStarted: row.clarify_started === 1,
    model: row.model,
    effort: row.effort,
    targetRepo: row.target_repo,
    acceptanceCriteria: row.acceptance_criteria,
    context: row.context,
    skills: parseJsonArray(row.skills),
    kbDigest: row.kb_digest === 1,
    digest: row.digest,
    agentStatus: row.agent_status,
    unchecked: row.unchecked === 1,
    hcRunIds: parseJsonArray(row.hc_run_ids),
    branch: row.branch,
    crUrl: row.cr_url,
    cellId: row.cell_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const EDIT_COLUMNS = {
  title: 'title',
  body: 'body',
  targetRepo: 'target_repo',
  acceptanceCriteria: 'acceptance_criteria',
  context: 'context',
  skills: 'skills',
  groomed: 'groomed',
  model: 'model',
  effort: 'effort',
  kbDigest: 'kb_digest',
  digest: 'digest',
  cellId: 'cell_id',
} as const satisfies Record<keyof EditInput, string>;

function encodeValue(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (Array.isArray(value)) return JSON.stringify(value);
  return value;
}

export class RequestRepository {
  constructor(private readonly db: Db) {}

  /** One place for `updated_at` and column encoding so every write behaves the same. */
  private write(id: string, assignments: Array<[column: string, value: unknown]>): void {
    if (assignments.length === 0) return;
    const sets = assignments.map(([column]) => `${column} = ?`);
    const values = assignments.map(([, value]) => encodeValue(value));
    sets.push('updated_at = ?');
    values.push(Date.now());
    this.db.prepare(`UPDATE requests SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  create(input: CreateInput): Request {
    const now = Date.now();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO requests (id, title, body, state, target_repo, cell_id, created_at, updated_at)
         VALUES (?, ?, ?, 'clarify', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.body ?? '',
        input.targetRepo ?? null,
        input.cellId ?? null,
        now,
        now,
      );
    return this.require(id);
  }

  get(id: string): Request | null {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as
      | RequestRow
      | undefined;
    return row ? toRequest(row) : null;
  }

  require(id: string): Request {
    const request = this.get(id);
    if (!request) throw new RequestError('NOT_FOUND', `request ${id} not found`);
    return request;
  }

  list(filter: ListFilter = {}): Request[] {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.view === 'intake') {
      clauses.push("state = 'clarify' AND clarify_started = 0");
    } else if (filter.state) {
      clauses.push('state = ?');
      params.push(filter.state);
    }

    if (filter.cellId === null) {
      clauses.push('cell_id IS NULL');
    } else if (filter.cellId !== undefined) {
      clauses.push('cell_id = ?');
      params.push(filter.cellId);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM requests ${where} ORDER BY updated_at DESC`)
      .all(...params) as RequestRow[];
    return rows.map(toRequest);
  }

  setClarifyStarted(id: string, started: boolean): Request {
    this.require(id);
    this.write(id, [['clarify_started', started]]);
    return this.require(id);
  }

  edit(id: string, fields: EditInput): Request {
    this.require(id);

    const source = fields as Record<string, unknown>;
    const assignments: Array<[string, unknown]> = [];
    for (const [key, column] of Object.entries(EDIT_COLUMNS)) {
      const value = source[key];
      if (value === undefined) continue;
      assignments.push([column, value]);
    }

    this.write(id, assignments);
    return this.require(id);
  }

  transition(id: string, to: State): Request {
    const request = this.require(id);
    if (!canTransition(request.state, to)) {
      throw new RequestError(
        'ILLEGAL_TRANSITION',
        `cannot move request from ${request.state} to ${to}`,
      );
    }
    this.write(id, [['state', to]]);
    return this.require(id);
  }

  addRun(id: string, runId: string): Request {
    const request = this.require(id);
    this.write(id, [['hc_run_ids', JSON.stringify([...request.hcRunIds, runId])]]);
    return this.require(id);
  }

  setAgentStatus(id: string, status: AgentStatus): void {
    this.write(id, [['agent_status', status]]);
  }

  /** Requests currently working in a cell (or unassigned when cellId is null). */
  countWorking(cellId: string | null, state?: State): number {
    const clauses = ["agent_status = 'working'"];
    const params: Array<string | null> = [];
    if (cellId === null) {
      clauses.push('cell_id IS NULL');
    } else {
      clauses.push('cell_id = ?');
      params.push(cellId);
    }
    if (state !== undefined) {
      clauses.push('state = ?');
      params.push(state);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM requests WHERE ${clauses.join(' AND ')}`)
      .get(...params) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  setUnchecked(id: string, unchecked: boolean): void {
    this.write(id, [['unchecked', unchecked]]);
  }

  setBranch(id: string, branch: string | null): void {
    this.write(id, [['branch', branch]]);
  }
}
