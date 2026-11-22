import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { ZodError, z } from 'zod';
import { CellNotFoundError, type CellRepository } from '../cells/repository.js';
import type { Engine, LiveTurn } from '../clarify/engine.js';
import { KB_SESSION_ID, isMasterSession, isSetupSession, masterCellId } from '../clarify/engine.js';
import { isVirtualSessionId } from '../clarify/engine.js';
import type { ModelCatalog } from '../clarify/models.js';
import type { Config } from '../config.js';
import { worktreePath } from '../clarify/worktree.js';
import { DocsService } from '../docs/service.js';
import {
  EFFORT_LEVELS,
  STATES,
  isTerminal,
  type ClarifyEvent,
  type Request,
} from '../domain/request.js';
import type { KbRepository } from '../kb/repository.js';
import type { ErrorSink } from '../logging/errors.js';
import type { MasterEventRepository } from '../master/events.js';
import type { MasterScheduler } from '../master/scheduler.js';
import { PluginError, type PluginManager } from '../plugins/manager.js';
import { processSchema, segmentSchema } from '../process/defaults.js';
import type { ProcessStore } from '../process/store.js';
import type { CellDraftStore } from '../cells/drafts.js';
import type { RequestRepository } from '../requests/repository.js';
import { RequestError } from '../requests/repository.js';
import type { SettingsStore } from '../settings.js';
import { SkillCatalog } from '../skills/catalog.js';
import type { SummaryRepository } from '../summary/repository.js';
import type { SummaryScheduler } from '../summary/scheduler.js';
import { TerminalService, TerminalError } from '../terminal/service.js';
import { errorMessage } from '../util/errors.js';

export interface ServerDeps {
  repo: RequestRepository;
  cells: CellRepository;
  drafts: CellDraftStore;
  kb: KbRepository;
  engine: Engine;
  models: ModelCatalog;
  plugins: PluginManager;
  settings: SettingsStore;
  master: MasterScheduler;
  masterEvents: MasterEventRepository;
  summary: SummaryScheduler;
  summaries: SummaryRepository;
  process: ProcessStore;
  skills?: SkillCatalog;
  docs?: DocsService;
  errorLog?: ErrorSink;
  config: Config;
  logger?: boolean;
}

const createSchema = z.object({
  title: z.string().min(1),
  body: z.string().optional(),
  targetRepo: z.string().nullable().optional(),
  cellId: z.string().nullable().optional(),
});

const editSchema = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  targetRepo: z.string().nullable().optional(),
  acceptanceCriteria: z.string().nullable().optional(),
  context: z.string().nullable().optional(),
  skills: z.array(z.string()).optional(),
  groomed: z.boolean().optional(),
  model: z.string().nullable().optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
  kbDigest: z.boolean().optional(),
  digest: z.string().nullable().optional(),
  cellId: z.string().nullable().optional(),
});

const listQuerySchema = z.object({
  view: z.literal('intake').optional(),
  state: z.enum(STATES).optional(),
  cellId: z.string().optional(),
});

const transitionSchema = z.object({ to: z.enum(STATES) });
const sendSchema = z.object({ text: z.string().min(1) });
const indexSchema = z.object({
  digest: z.string().nullable().optional(),
  index: z.boolean().optional(),
});
const kbSchema = z.object({
  requestId: z.string().min(1),
  title: z.string().min(1),
  content: z.string(),
});
const kbQuerySchema = z.object({
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const pluginSchema = z.object({
  url: z.string().min(1),
  subdir: z.string().optional(),
  name: z.string().optional(),
});
const cellSchema = z.object({
  name: z.string().min(1),
  process: processSchema.optional(),
  masterIntervalMinutes: z.number().int().min(1).max(24 * 60).nullable().optional(),
  maxConcurrent: z.number().int().min(1).max(50).optional(),
  model: z.string().nullable().optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
  autocompactPercent: z.number().int().min(1).max(99).optional(),
});
const cellDraftSchema = z.object({
  name: z.string().min(1),
  process: processSchema,
  masterIntervalMinutes: z.number().int().min(1).max(24 * 60).nullable(),
  maxConcurrent: z.number().int().min(1).max(50),
  model: z.string().nullable(),
  effort: z.enum(EFFORT_LEVELS).nullable(),
  autocompactPercent: z.number().int().min(1).max(99),
});
const followUpUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  marker: z.string().min(1).max(80).optional(),
});
const segmentUpdateSchema = segmentSchema
  .omit({ id: true, followUps: true })
  .partial()
  .extend({
    id: segmentSchema.shape.id,
    followUps: followUpUpdateSchema.optional(),
  });
const cellDraftPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    process: processSchema.optional(),
    segments: z.array(segmentSchema).optional(),
    segmentUpdates: z.array(segmentUpdateSchema).optional(),
    masterIntervalMinutes: z.number().int().min(1).max(24 * 60).nullable().optional(),
    maxConcurrent: z.number().int().min(1).max(50).optional(),
    model: z.string().nullable().optional(),
    effort: z.enum(EFFORT_LEVELS).nullable().optional(),
    autocompactPercent: z.number().int().min(1).max(99).optional(),
  })
  .refine(
    (value) =>
      Object.values(value).some((field) => field !== undefined),
    { message: 'at least one draft field is required' },
  );
const cellPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    masterEnabled: z.boolean().optional(),
    masterIntervalMinutes: z.number().int().min(1).max(24 * 60).nullable().optional(),
    maxConcurrent: z.number().int().min(1).max(50).optional(),
    model: z.string().nullable().optional(),
    effort: z.enum(EFFORT_LEVELS).nullable().optional(),
    autocompactPercent: z.number().int().min(1).max(99).optional(),
    process: processSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.masterEnabled !== undefined ||
      value.masterIntervalMinutes !== undefined ||
      value.maxConcurrent !== undefined ||
      value.model !== undefined ||
      value.effort !== undefined ||
      value.autocompactPercent !== undefined ||
      value.process !== undefined,
    {
      message:
        'name, masterEnabled, masterIntervalMinutes, maxConcurrent, model, effort, autocompactPercent, or process is required',
    },
  );
const masterEventsQuerySchema = z.object({
  cellId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const masterQuerySchema = z.object({ cellId: z.string().optional() });
const summariesQuerySchema = z.object({
  cellId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const summaryCellQuerySchema = z.object({ cellId: z.string().min(1) });
const summaryStatusQuerySchema = z.object({ cellId: z.string().min(1).optional() });
const skillsQuerySchema = z.object({ requestId: z.string().optional() });
const terminalCreateSchema = z.object({
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(200).optional(),
});

interface Stream {
  emit: (event: ClarifyEvent) => void;
  end: () => void;
}

function openStream(reply: FastifyReply): Stream {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });

  let closed = false;
  reply.raw.on('close', () => {
    closed = true;
  });

  return {
    emit(event) {
      if (closed) return;
      reply.raw.write(`${JSON.stringify(event)}\n`);
    },
    end() {
      if (closed) return;
      closed = true;
      reply.raw.end();
    },
  };
}

async function streamTurn(
  reply: FastifyReply,
  engine: Engine,
  id: string,
  turn: LiveTurn,
  fallbackRequest: () => Request | null,
): Promise<void> {
  const stream = openStream(reply);

  const attached = engine.attach(id, (event) => {
    stream.emit(event);
    if (event.t === 'done') stream.end();
  });

  if (!attached) {
    stream.emit({ t: 'done', request: fallbackRequest(), transcript: engine.transcript(id) });
    stream.end();
    return;
  }

  await turn.promise;
  // `done` is broadcast from the turn's finally block just after its promise
  // resolves; give that continuation one tick before closing the response.
  await new Promise<void>((resolve) => setImmediate(resolve));
  stream.end();
}

/** Stream a started turn, or return immediately when the caller asked to detach. */
async function respondTurn(
  reply: FastifyReply,
  engine: Engine,
  id: string,
  turnPromise: Promise<LiveTurn>,
  fallbackRequest: () => Request | null,
  detach: boolean,
): Promise<void | { started: true }> {
  const turn = await turnPromise;
  if (detach) return { started: true };
  return streamTurn(reply, engine, id, turn, fallbackRequest);
}

function isVirtualSession(id: string): boolean {
  return isVirtualSessionId(id);
}

function masterChatContext(cells: CellRepository, id: string): string | undefined {
  const cellId = masterCellId(id);
  if (!cellId) return 'Scope: unassigned work and the global process template.';
  const cell = cells.get(cellId);
  if (!cell) return 'Scope: a cell that no longer exists.';
  const interval = cell.masterIntervalMinutes
    ? `${cell.masterIntervalMinutes} minutes`
    : 'the global interval';
  const policy = cell.process ? 'this cell’s own process snapshot' : 'the global process template';
  return `Scope: cell "${cell.name}". Master interval: ${interval}. Policy: ${policy}.`;
}

/** Start or continue a turn, routing the reserved sessions to their own entry points. */
function sessionTurn(
  engine: Engine,
  id: string,
  text?: string,
  context?: string,
): Promise<LiveTurn> {
  if (id === KB_SESSION_ID) return engine.startKb(text ?? '');
  if (isSetupSession(id)) return engine.startSetup(text ?? '', id);
  if (isMasterSession(id)) return engine.startMaster(text ?? '', id, context);
  return text === undefined ? engine.start(id) : engine.send(id, text);
}

/** `?detach=1` starts a workflow turn without holding the HTTP response open. */
function wantsDetach(query: unknown): boolean {
  if (typeof query !== 'object' || query === null) return false;
  return (query as { detach?: unknown }).detach === '1';
}

function assertCell(cells: CellRepository, cellId: string | null | undefined): void {
  if (cellId) cells.require(cellId);
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const {
    repo,
    cells,
    drafts,
    kb,
    engine,
    models,
    plugins,
    settings,
    master,
    masterEvents,
    summary,
    summaries,
    process: processStore,
    skills,
    errorLog,
    config,
  } = deps;
  const app = Fastify({ logger: deps.logger ?? false });
  const terminal = new TerminalService(config.terminalEnabled, config.terminalCwd);
  const docs = deps.docs ?? new DocsService(config.docsDir);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'invalid', issues: error.issues });
    }
    if (error instanceof RequestError) {
      const status = error.code === 'NOT_FOUND' ? 404 : 409;
      return reply.code(status).send({ error: error.code.toLowerCase(), message: error.message });
    }
    if (error instanceof CellNotFoundError) {
      return reply.code(404).send({ error: 'not_found', message: error.message });
    }
    if (error instanceof PluginError) {
      const status = error.code === 'NOT_FOUND' ? 404 : 400;
      return reply.code(status).send({ error: error.code.toLowerCase(), message: error.message });
    }
    if (error instanceof TerminalError) {
      return reply.code(400).send({ error: 'terminal', message: error.message });
    }
    app.log.error(error);
    errorLog?.error('http.request', error, {
      requestId: request.id,
      method: request.method,
      url: request.url,
    });
    return reply.code(500).send({ error: 'internal', message: errorMessage(error) });
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/api/docs', async () => ({ pages: docs.list() }));

  // Serve only docs/screenshots; the service rejects traversal and non-images.
  app.get('/api/docs/assets/*', async (request, reply) => {
    const params = request.params as { '*': string };
    const asset = docs.asset(params['*']);
    if (!asset) return reply.code(404).send({ error: 'not_found' });
    return reply.type(asset.type).send(readFileSync(asset.file));
  });

  app.get('/api/docs/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const doc = docs.read(slug);
    if (!doc) return reply.code(404).send({ error: 'not_found' });
    return doc;
  });

  app.get('/api/terminal', async () => terminal.status());
  app.get('/api/terminals', async () => terminal.list());
  app.post('/api/terminals', async (request, reply) => {
    const input = terminalCreateSchema.parse(request.body ?? {});
    try {
      return reply.code(201).send(terminal.create(input));
    } catch (error) {
      errorLog?.error('terminal.create', error);
      throw error;
    }
  });
  app.delete('/api/terminals/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!terminal.close(id)) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.get('/api/requests', async (request) => {
    const query = listQuerySchema.parse(request.query);
    return repo.list(query);
  });

  app.get('/api/requests/:id', async (request) => {
    const { id } = request.params as { id: string };
    return repo.require(id);
  });

  app.post('/api/requests', async (request, reply) => {
    const input = createSchema.parse(request.body);
    assertCell(cells, input.cellId);
    const created = repo.create(input);
    return reply.code(201).send(created);
  });

  app.patch('/api/requests/:id', async (request) => {
    const { id } = request.params as { id: string };
    const fields = editSchema.parse(request.body);
    assertCell(cells, fields.cellId);
    return repo.edit(id, fields);
  });

  app.post('/api/requests/:id/transition', async (request) => {
    const { id } = request.params as { id: string };
    const { to } = transitionSchema.parse(request.body);
    const updated = repo.transition(id, to);
    if (isTerminal(to)) await engine.dispose(id);
    return updated;
  });

  app.post('/api/requests/:id/drop', async (request) => {
    const { id } = request.params as { id: string };
    const current = repo.require(id);
    const updated = isTerminal(current.state)
      ? current
      : repo.transition(id, 'dropped');
    await engine.dispose(id);
    return updated;
  });

  app.post('/api/requests/:id/seen', async (request) => {
    const { id } = request.params as { id: string };
    repo.require(id);
    repo.setUnchecked(id, false);
    return repo.require(id);
  });

  app.post('/api/requests/:id/clarify/start', async (request, reply) => {
    const { id } = request.params as { id: string };
    return respondTurn(
      reply,
      engine,
      id,
      sessionTurn(engine, id, undefined, masterChatContext(cells, id)),
      () => (isVirtualSession(id) ? null : repo.get(id)),
      wantsDetach(request.query),
    );
  });

  app.post('/api/requests/:id/clarify/send', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { text } = sendSchema.parse(request.body);
    return respondTurn(
      reply,
      engine,
      id,
      sessionTurn(engine, id, text, masterChatContext(cells, id)),
      () => (isVirtualSession(id) ? null : repo.get(id)),
      wantsDetach(request.query),
    );
  });

  app.post('/api/requests/:id/clarify/stop', async (request) => {
    const { id } = request.params as { id: string };
    return { stopped: engine.cancel(id) };
  });

  app.get('/api/requests/:id/clarify/stream', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!engine.hasLive(id)) return reply.send({ active: false });

    const stream = openStream(reply);
    const attached = engine.attach(id, (event) => {
      stream.emit(event);
      if (event.t === 'done') stream.end();
    });
    if (!attached) return stream.end();
    return reply;
  });

  app.get('/api/requests/:id/clarify', async (request) => {
    const { id } = request.params as { id: string };
    if (isVirtualSession(id)) {
      return {
        started: true,
        transcript: engine.transcript(id),
        active: engine.hasLive(id),
      };
    }
    const found = repo.require(id);
    return {
      started: found.clarifyStarted,
      transcript: engine.transcript(id),
      active: engine.hasLive(id),
    };
  });

  app.post('/api/requests/:id/dispatch', async (request, reply) => {
    const { id } = request.params as { id: string };
    return respondTurn(
      reply,
      engine,
      id,
      engine.kickoffDispatch(id),
      () => repo.get(id),
      wantsDetach(request.query),
    );
  });

  app.post('/api/requests/:id/finalize', async (request, reply) => {
    const { id } = request.params as { id: string };
    return respondTurn(
      reply,
      engine,
      id,
      engine.kickoffFinalize(id),
      () => repo.get(id),
      wantsDetach(request.query),
    );
  });

  app.post('/api/requests/:id/index', async (request) => {
    const { id } = request.params as { id: string };
    const body = indexSchema.parse(request.body ?? {});

    if (body.digest !== undefined) repo.edit(id, { digest: body.digest });
    const current = repo.require(id);

    if (body.index === true && current.kbDigest) {
      const digest = body.digest ?? current.digest;
      if (digest && digest.trim() !== '') {
        kb.store({ requestId: id, title: current.title, content: digest });
      }
    }

    const done = repo.transition(id, 'done');
    await engine.dispose(id);
    return done;
  });

  app.get('/api/models', async (request) => {
    const query = z.object({ refresh: z.string().optional() }).parse(request.query);
    const catalog = await models.list(query.refresh === '1');
    return {
      ...catalog,
      harness: config.harness,
      supportsEffort: config.harness === 'claude',
      defaultModel: config.defaultModel,
    };
  });

  app.get('/api/kb', async (request) => {
    const query = kbQuerySchema.parse(request.query);
    if (query.q !== undefined) return kb.search(query.q, query.limit ?? 20);
    return kb.list();
  });

  app.post('/api/kb', async (request, reply) => {
    const input = kbSchema.parse(request.body);
    return reply.code(201).send(kb.store(input));
  });

  app.get('/api/cells', async () => cells.list());

  app.get('/api/cell-drafts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const draft = drafts.get(id);
    if (!draft) return reply.code(404).send({ error: 'not_found' });
    return draft;
  });

  app.put('/api/cell-drafts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = cellDraftSchema.parse(request.body);
    return drafts.put({ id, ...input });
  });

  app.patch('/api/cell-drafts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const current = drafts.get(id);
    if (!current) return reply.code(404).send({ error: 'not_found' });
    const input = cellDraftPatchSchema.parse(request.body);
    let process = current.process;
    if (input.process !== undefined) process = input.process;
    if (input.segments !== undefined) {
      process = processSchema.parse({ version: 1, segments: input.segments });
    }
    if (input.segmentUpdates !== undefined) {
      const updates = new Map(input.segmentUpdates.map((segment) => [segment.id, segment]));
      const segments = process.segments.map((segment) => {
        const update = updates.get(segment.id);
        if (!update) return segment;
        return {
          ...segment,
          ...update,
          ...(update.followUps
            ? { followUps: { ...segment.followUps, ...update.followUps } }
            : {}),
        };
      });
      process = processSchema.parse({ version: 1, segments });
    }
    return drafts.patch(id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.masterIntervalMinutes !== undefined
        ? { masterIntervalMinutes: input.masterIntervalMinutes }
        : {}),
      ...(input.maxConcurrent !== undefined ? { maxConcurrent: input.maxConcurrent } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.autocompactPercent !== undefined
        ? { autocompactPercent: input.autocompactPercent }
        : {}),
      process,
    });
  });

  app.delete('/api/cell-drafts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    drafts.remove(id);
    return reply.code(204).send();
  });

  app.get('/api/cells/:id', async (request) => {
    const { id } = request.params as { id: string };
    return cells.require(id);
  });

  app.post('/api/cells', async (request, reply) => {
    const input = cellSchema.parse(request.body);
    const created = cells.create(
      input.name,
      input.process ?? processStore.get(),
      input.masterIntervalMinutes ?? null,
      {
        maxConcurrent: input.maxConcurrent,
        model: input.model,
        effort: input.effort,
        autocompactPercent: input.autocompactPercent,
      },
    );
    master.refresh();
    summary.refresh();
    return reply.code(201).send(created);
  });

  app.patch('/api/cells/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = cellPatchSchema.parse(request.body);
    if (body.name !== undefined) cells.rename(id, body.name);
    if (body.masterEnabled !== undefined) cells.setMasterEnabled(id, body.masterEnabled);
    if (body.masterIntervalMinutes !== undefined) {
      cells.setMasterInterval(id, body.masterIntervalMinutes);
    }
    if (body.maxConcurrent !== undefined) cells.setMaxConcurrent(id, body.maxConcurrent);
    if (body.model !== undefined || body.effort !== undefined) {
      const current = cells.require(id);
      cells.setAgentDefaults(
        id,
        body.model !== undefined ? body.model : current.model,
        body.effort !== undefined ? body.effort : current.effort,
      );
    }
    if (body.autocompactPercent !== undefined) {
      cells.setAutocompactPercent(id, body.autocompactPercent);
    }
    if (body.process !== undefined) cells.setProcess(id, body.process);
    master.refresh();
    summary.refresh();
    return cells.require(id);
  });

  app.delete('/api/cells/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    cells.remove(id);
    master.refresh();
    summary.refresh();
    return reply.code(204).send();
  });

  app.get('/api/plugins', async () => plugins.list());

  app.post('/api/plugins', async (request, reply) => {
    const input = pluginSchema.parse(request.body);
    return reply.code(201).send(await plugins.install(input));
  });

  app.delete('/api/plugins/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    plugins.remove(name);
    return reply.code(204).send();
  });

  app.get('/api/commands', async () => plugins.listCommands());
  app.get('/api/skills', async (request) => {
    const query = skillsQuerySchema.parse(request.query);
    if (query.requestId) {
      const found = repo.get(query.requestId);
      if (found?.targetRepo) {
        const dir = worktreePath(config.dataDir, found.id);
        const cwd = existsSync(dir) ? dir : found.targetRepo;
        return new SkillCatalog({ cwd }).list();
      }
    }
    return skills?.list() ?? [];
  });

  app.get('/api/config', async () => ({ ...settings.get(), path: settings.path }));
  app.patch('/api/config', async (request) => ({
    ...settings.patch(request.body),
    path: settings.path,
  }));

  app.get('/api/process', async () => ({ ...processStore.get(), path: processStore.path }));
  app.patch('/api/process', async (request) => ({
    ...processStore.patch(request.body),
    path: processStore.path,
  }));

  app.get('/api/master/status', async (request) => {
    const query = masterQuerySchema.parse(request.query);
    return query.cellId ? master.statusFor(query.cellId) : master.status();
  });
  app.post('/api/master/run', async (request) => {
    const query = masterQuerySchema.parse(request.query);
    return query.cellId ? master.runNow(query.cellId) : master.runNow();
  });
  app.get('/api/master/events', async (request) => {
    const query = masterEventsQuerySchema.parse(request.query);
    return masterEvents.list(query);
  });

  app.get('/api/summaries', async (request) => {
    const query = summariesQuerySchema.parse(request.query);
    if (query.cellId) cells.require(query.cellId);
    return summaries.list(query);
  });
  app.get('/api/summaries/latest', async (request) => {
    const query = summaryCellQuerySchema.parse(request.query);
    cells.require(query.cellId);
    return summaries.latest(query.cellId);
  });
  app.get('/api/summaries/status', async (request) => {
    const query = summaryStatusQuerySchema.parse(request.query);
    if (query.cellId) cells.require(query.cellId);
    return query.cellId ? summary.statusFor(query.cellId) : summary.status();
  });
  app.post('/api/summaries/run', async (request) => {
    const query = summaryCellQuerySchema.parse(request.query);
    cells.require(query.cellId);
    return summary.runNow(query.cellId);
  });

  await app.register(fastifyWebsocket);
  app.get('/ws', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ t: 'hello' }));
    socket.on('message', (raw: Buffer) => socket.send(raw.toString()));
  });

  app.get('/ws/terminal', { websocket: true }, (socket, request) => {
    const query = request.query as { sessionId?: string; cols?: string; rows?: string };
    const sessionId = typeof query.sessionId === 'string' ? query.sessionId : '';
    const send = (value: unknown): void => {
      if (socket.readyState === 1) socket.send(JSON.stringify(value));
    };

    const attachment = sessionId ? terminal.attach(sessionId, (event) => {
      if (event.t === 'closed') {
        send({ t: 'closed' });
        if (socket.readyState === 1) socket.close(1000, 'terminal closed');
        return;
      }
      send(event);
      if (event.t === 'exit' && socket.readyState === 1) {
        socket.close(1000, 'shell exited');
      }
    }) : null;

    if (!attachment) {
      errorLog?.error('terminal.attach', new Error('terminal not found'), { sessionId });
      send({ t: 'error', message: 'terminal session not found' });
      socket.close(1008, 'terminal not found');
      return;
    }

    terminal.resize(
      sessionId,
      Number(query.cols ?? 100),
      Number(query.rows ?? 30),
    );
    send({ t: 'ready', session: attachment.session });
    if (attachment.buffer !== '') send({ t: 'buffer', data: attachment.buffer });
    if (!attachment.session.alive) {
      send({ t: 'exit', code: attachment.session.exitCode });
      if (socket.readyState === 1) socket.close(1000, 'shell exited');
      return;
    }

    socket.on('message', (raw: Buffer) => {
      try {
        const message = JSON.parse(raw.toString()) as {
          type?: string;
          data?: string;
          cols?: number;
          rows?: number;
        };
        if (message.type === 'input' && typeof message.data === 'string') {
          terminal.write(sessionId, message.data);
        } else if (message.type === 'resize') {
          terminal.resize(sessionId, Number(message.cols), Number(message.rows));
        }
      } catch {
        // Malformed frame; ignore it rather than tearing down the shell.
      }
    });
    socket.on('close', () => attachment.detach());
    socket.on('error', () => attachment.detach());
  });

  if (existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: config.webDir });
    app.setNotFoundHandler((request, reply) => {
      const wantsSpa =
        request.method === 'GET' &&
        !request.url.startsWith('/api') &&
        !request.url.startsWith('/ws') &&
        !request.url.startsWith('/assets/');
      if (wantsSpa) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  }

  return app;
}
