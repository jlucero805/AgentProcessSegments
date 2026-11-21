import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { existsSync } from 'node:fs';
import { ZodError, z } from 'zod';
import { CellNotFoundError, type CellRepository } from '../cells/repository.js';
import type { Engine, LiveTurn } from '../clarify/engine.js';
import { KB_SESSION_ID } from '../clarify/engine.js';
import type { ModelCatalog } from '../clarify/models.js';
import type { Config } from '../config.js';
import {
  EFFORT_LEVELS,
  STATES,
  TERMINAL_STATES,
  type ClarifyEvent,
  type Request,
} from '../domain/request.js';
import type { KbRepository } from '../kb/repository.js';
import type { MasterEventRepository } from '../master/events.js';
import type { MasterScheduler } from '../master/scheduler.js';
import { PluginError, type PluginManager } from '../plugins/manager.js';
import type { RequestRepository } from '../requests/repository.js';
import { RequestError } from '../requests/repository.js';
import type { SettingsStore } from '../settings.js';

export interface ServerDeps {
  repo: RequestRepository;
  cells: CellRepository;
  kb: KbRepository;
  engine: Engine;
  models: ModelCatalog;
  plugins: PluginManager;
  settings: SettingsStore;
  master: MasterScheduler;
  masterEvents: MasterEventRepository;
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
const cellSchema = z.object({ name: z.string().min(1) });
const cellPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    masterEnabled: z.boolean().optional(),
  })
  .refine((value) => value.name !== undefined || value.masterEnabled !== undefined, {
    message: 'name or masterEnabled is required',
  });
const masterEventsQuerySchema = z.object({
  cellId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
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
  turnPromise: Promise<LiveTurn>,
  fallbackRequest: () => Request | null,
): Promise<void> {
  const turn = await turnPromise;
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

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { repo, cells, kb, engine, models, plugins, settings, master, masterEvents, config } =
    deps;
  const app = Fastify({ logger: deps.logger ?? false });

  app.setErrorHandler((error, _request, reply) => {
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
    app.log.error(error);
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: 'internal', message });
  });

  app.get('/health', async () => ({ ok: true }));

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
    const created = repo.create(input);
    return reply.code(201).send(created);
  });

  app.patch('/api/requests/:id', async (request) => {
    const { id } = request.params as { id: string };
    const fields = editSchema.parse(request.body);
    return repo.edit(id, fields);
  });

  app.post('/api/requests/:id/transition', async (request) => {
    const { id } = request.params as { id: string };
    const { to } = transitionSchema.parse(request.body);
    const updated = repo.transition(id, to);
    if (TERMINAL_STATES.includes(to)) await engine.dispose(id);
    return updated;
  });

  app.post('/api/requests/:id/drop', async (request) => {
    const { id } = request.params as { id: string };
    const current = repo.require(id);
    const updated = TERMINAL_STATES.includes(current.state)
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
    const isKb = id === KB_SESSION_ID;
    const turn = isKb ? engine.startKb('') : engine.start(id);
    return streamTurn(reply, engine, id, turn, () => (isKb ? null : repo.get(id)));
  });

  app.post('/api/requests/:id/clarify/send', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { text } = sendSchema.parse(request.body);
    const isKb = id === KB_SESSION_ID;
    const turn = isKb ? engine.startKb(text) : engine.send(id, text);
    return streamTurn(reply, engine, id, turn, () => (isKb ? null : repo.get(id)));
  });

  app.post('/api/requests/:id/clarify/stop', async (request) => {
    const { id } = request.params as { id: string };
    return { stopped: engine.cancel(id) };
  });

  app.get('/api/requests/:id/clarify/stream', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!engine.hasLive(id)) return reply.send({ active: false });

    const isKb = id === KB_SESSION_ID;
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
    if (id === KB_SESSION_ID) {
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
    return streamTurn(reply, engine, id, engine.kickoffDispatch(id), () => repo.get(id));
  });

  app.post('/api/requests/:id/finalize', async (request, reply) => {
    const { id } = request.params as { id: string };
    return streamTurn(reply, engine, id, engine.kickoffFinalize(id), () => repo.get(id));
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

  app.post('/api/cells', async (request, reply) => {
    const { name } = cellSchema.parse(request.body);
    return reply.code(201).send(cells.create(name));
  });

  app.patch('/api/cells/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = cellPatchSchema.parse(request.body);
    if (body.name !== undefined) cells.rename(id, body.name);
    if (body.masterEnabled !== undefined) cells.setMasterEnabled(id, body.masterEnabled);
    return cells.require(id);
  });

  app.delete('/api/cells/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    cells.remove(id);
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

  app.get('/api/config', async () => ({ ...settings.get(), path: settings.path }));
  app.patch('/api/config', async (request) => ({
    ...settings.patch(request.body),
    path: settings.path,
  }));

  app.get('/api/master/status', async () => master.status());
  app.post('/api/master/run', async () => master.runNow());
  app.get('/api/master/events', async (request) => {
    const query = masterEventsQuerySchema.parse(request.query);
    return masterEvents.list(query);
  });

  await app.register(fastifyWebsocket);
  app.get('/ws', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ t: 'hello' }));
    socket.on('message', (raw: Buffer) => socket.send(raw.toString()));
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
