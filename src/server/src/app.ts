import { pathToFileURL } from 'node:url';
import { CellRepository } from './cells/repository.js';
import { Engine } from './clarify/engine.js';
import { ModelCatalog } from './clarify/models.js';
import { ClaudeCliTransport } from './clarify/transport.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { buildServer } from './http/server.js';
import { KbRepository } from './kb/repository.js';
import { RequestRepository } from './requests/repository.js';

export async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbPath);

  const repo = new RequestRepository(db);
  const cells = new CellRepository(db);
  const kb = new KbRepository(db);
  const engine = new Engine({
    repo,
    transport: new ClaudeCliTransport(config.claudeBin),
    config,
  });
  const models = new ModelCatalog(config.claudeBin);

  const app = await buildServer({ repo, cells, kb, engine, models, config });
  await app.listen({ host: config.host, port: config.port });

  const shutdown = async () => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
