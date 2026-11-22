import { pathToFileURL } from 'node:url';
import { CellRepository } from './cells/repository.js';
import { CellDraftStore } from './cells/drafts.js';
import { Engine } from './clarify/engine.js';
import { createHarness } from './clarify/harnesses/index.js';
import { ModelCatalog } from './clarify/models.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { DocsService } from './docs/service.js';
import { buildServer } from './http/server.js';
import { KbRepository } from './kb/repository.js';
import { ErrorLogger } from './logging/errors.js';
import { MasterEventRepository } from './master/events.js';
import { MasterScheduler } from './master/scheduler.js';
import { MasterService } from './master/service.js';
import { PluginManager } from './plugins/manager.js';
import { defaultProcess } from './process/defaults.js';
import { ProcessStore } from './process/store.js';
import { RequestRepository } from './requests/repository.js';
import { SettingsStore } from './settings.js';
import { SkillCatalog } from './skills/catalog.js';

export async function main(): Promise<void> {
  const config = loadConfig();
  const errors = new ErrorLogger(config.errorLogPath, { maxBytes: config.errorLogMaxBytes });

  try {
    const db = openDb(config.dbPath);

    const repo = new RequestRepository(db);
    const cells = new CellRepository(db);
    const drafts = new CellDraftStore();
    const kb = new KbRepository(db);
    const plugins = new PluginManager(config.pluginsDir);
    const settings = new SettingsStore(config.configPath, errors);
    const processStore = new ProcessStore(
      config.processPath,
      () => defaultProcess(settings.get().master),
      errors,
    );
    const harness = createHarness(config);
    const engine = new Engine({
      repo,
      harness,
      config,
      pluginDirs: () => plugins.installedPluginDirs(),
      errors,
      cellDefaults: (cellId) => {
        const cell = cells.get(cellId);
        return cell ? { model: cell.model, effort: cell.effort } : null;
      },
    });
    const models = new ModelCatalog(harness);
    const skills = new SkillCatalog();
    const docs = new DocsService(config.docsDir);
    const masterEvents = new MasterEventRepository(db);
    const masterService = new MasterService({
      repo,
      cells,
      engine,
      settings,
      events: masterEvents,
      process: processStore,
      errors,
    });
    const master = new MasterScheduler(masterService, settings, cells, errors);

    const app = await buildServer({
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
      process: processStore,
      skills,
      docs,
      errorLog: errors,
      config,
    });
    master.start();
    await app.listen({ host: config.host, port: config.port });

    const shutdown = async () => {
      master.stop();
      // Keep-alive sockets from a closed client can hold `close()` open forever.
      const force = setTimeout(() => process.exit(0), 3000);
      force.unref();
      const closing = app.close();
      app.server.closeAllConnections();
      await closing.catch(() => {});
      db.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  } catch (error) {
    errors.error('app.startup', error);
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
