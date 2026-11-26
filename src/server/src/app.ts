import { pathToFileURL } from 'node:url';
import { BrainLock } from './brain-lock.js';
import { CellRepository } from './cells/repository.js';
import { CellDraftStore } from './cells/drafts.js';
import { Engine } from './clarify/engine.js';
import { createHarnessRegistry } from './clarify/harnesses/index.js';
import { HarnessModelCatalog } from './clarify/models.js';
import {
  blankPathEnvNames,
  blankPathWarning,
  legacyPathWarning,
  loadConfig,
} from './config.js';
import { openDb } from './db.js';
import { DocsService } from './docs/service.js';
import { legacyEnvNames, legacyEnvWarning } from './env.js';
import { buildServer } from './http/server.js';
import { KbRepository } from './kb/repository.js';
import { ErrorLogger } from './logging/errors.js';
import { LegacyBranchSweeper } from './maintenance/legacy-branch-sweeper.js';
import { MasterEventRepository } from './master/events.js';
import { MasterScheduler } from './master/scheduler.js';
import { MasterService } from './master/service.js';
import { NotificationEventDeliveryRepository } from './notifications/event-deliveries.js';
import { NotificationService } from './notifications/service.js';
import { PluginManager } from './plugins/manager.js';
import { PricingRepository } from './pricing/repository.js';
import { defaultProcess } from './process/defaults.js';
import { ProcessStore } from './process/store.js';
import { RequestRepository } from './requests/repository.js';
import { ArtifactRetention } from './retention/artifacts.js';
import { DataRetention } from './retention/service.js';
import { SettingsStore } from './settings.js';
import { SkillCatalog } from './skills/catalog.js';
import { SummaryRepository } from './summary/repository.js';
import { SummaryScheduler } from './summary/scheduler.js';
import { SummaryService } from './summary/service.js';
import { BudgetAlertRepository } from './usage/budget-alerts.js';
import { BudgetAlertDeliveryRepository } from './usage/budget-deliveries.js';
import { BudgetService } from './usage/budgets.js';
import { SpendCapOverrideRepository } from './usage/spend-cap-overrides.js';
import { UsageRepository } from './usage/repository.js';
import { UsageRetention } from './usage/retention.js';
import { SpendCapEnforcer } from './usage/spend-cap-enforcer.js';

export async function main(): Promise<void> {
  const config = loadConfig();
  const warning = legacyPathWarning(config.legacyPaths);
  if (warning) console.warn(warning);
  const legacyEnv = legacyEnvWarning(legacyEnvNames(process.env));
  if (legacyEnv) console.warn(legacyEnv);
  const blankPaths = blankPathWarning(blankPathEnvNames(process.env));
  if (blankPaths) console.warn(blankPaths);
  const errors = new ErrorLogger(config.errorLogPath, { maxBytes: config.errorLogMaxBytes });
  let brainLock: BrainLock | null = null;

  try {
    const db = openDb(config.dbPath);
    if (config.brainLock) {
      brainLock = new BrainLock({
        dataDir: config.dataDir,
        port: config.port,
        errors,
      });
      brainLock.start();
    }

    const repo = new RequestRepository(db);
    const cells = new CellRepository(db);
    const drafts = new CellDraftStore();
    const kb = new KbRepository(db);
    const usage = new UsageRepository(db);
    const pricing = new PricingRepository(db);
    const plugins = new PluginManager(config.pluginsDir);
    const settings = new SettingsStore(config.configPath, errors);
    const processStore = new ProcessStore(
      config.processPath,
      () => defaultProcess(settings.get().master),
      errors,
    );
    const budgetAlerts = new BudgetAlertRepository(db);
    const notifications = new NotificationService({
      deliveries: new BudgetAlertDeliveryRepository(db),
      events: new NotificationEventDeliveryRepository(db),
      alerts: budgetAlerts,
      cells,
      settings,
      errors,
      brainUrl: config.brainUrl,
    });
    // Late-bound: budgets evaluates before the engine exists, and the engine's
    // usage hook must reach the enforcer that owns the live turns.
    let enforcement: SpendCapEnforcer | null = null;
    const budgets = new BudgetService({
      usage,
      cells,
      settings,
      alerts: budgetAlerts,
      overrides: new SpendCapOverrideRepository(db),
      errors,
      onAlerts: (alerts) => notifications.observe(alerts),
      onOverride: (event) => notifications.observeSpendOverride(event),
      onEvaluated: () => enforcement?.check(),
    });
    const harnesses = createHarnessRegistry(config, errors);
    const engine = new Engine({
      repo,
      harnesses,
      config,
      usage,
      pluginDirs: () => plugins.installedPluginDirs(),
      errors,
      spendCap: (cellId) => budgets.admission(cellId),
      onUsageRecorded: () => enforcement?.check(),
      onTurnFailure: (event) => notifications.observeTurnFailure(event),
      cellConfig: (cellId) => {
        const cell = cells.get(cellId);
        return cell
          ? {
              model: cell.model,
              effort: cell.effort,
              harness: cell.harness,
              autocompactPercent: cell.autocompactPercent,
            }
          : null;
      },
    });
    enforcement = new SpendCapEnforcer({
      engine,
      admission: (cellId) => budgets.admission(cellId),
      errors,
    });
    const models = new HarnessModelCatalog({
      claude: harnesses.get('claude'),
      opencode: harnesses.get('opencode'),
    });
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
      spendCap: (cellId) => budgets.admission(cellId),
      onMasterError: (event) => notifications.observeMasterError(event),
    });
    const master = new MasterScheduler(masterService, settings, cells, errors, (event) =>
      notifications.observeMasterError(event),
    );
    const summaries = new SummaryRepository(db);
    const summaryService = new SummaryService({
      repo,
      cells,
      engine,
      settings,
      events: masterEvents,
      summaries,
      errors,
      onSummaryFailure: (event) => notifications.observeSummaryFailure(event),
    });
    const summary = new SummaryScheduler({
      service: summaryService,
      settings,
      cells,
      summaries,
      errors,
      spendCap: (cellId) => budgets.admission(cellId),
    });
    const usageRetention = new UsageRetention({ db, settings, errors });
    const dataRetention = new DataRetention({ db, settings, errors });
    const artifactRetention = new ArtifactRetention({
      dataDir: config.dataDir,
      repo,
      settings,
      errors,
      isBusy: (id) => engine.hasLive(id),
    });
    const legacyBranchSweeper = new LegacyBranchSweeper({
      repo,
      errors,
      isBusy: (id) => engine.hasLive(id),
    });

    const app = await buildServer({
      repo,
      cells,
      drafts,
      kb,
      usage,
      pricing,
      engine,
      models,
      plugins,
      settings,
      budgets,
      notifications,
      master,
      masterEvents,
      summary,
      summaries,
      process: processStore,
      skills,
      docs,
      errorLog: errors,
      config,
    });
    master.start();
    await app.listen({ host: config.host, port: config.port });
    // Catch-up generations may call the bundled `aps` MCP server, so start after the
    // HTTP brain is accepting connections.
    summary.start();
    // Fire-and-forget: a first-time prune must not delay readiness.
    usageRetention.start();
    dataRetention.start();
    artifactRetention.start();
    legacyBranchSweeper.start();
    budgets.start();
    notifications.start();

    const shutdown = async () => {
      legacyBranchSweeper.stop();
      artifactRetention.stop();
      dataRetention.stop();
      usageRetention.stop();
      master.stop();
      summary.stop();
      notifications.stop();
      budgets.stop();
      // Keep-alive sockets from a closed client can hold `close()` open forever.
      const force = setTimeout(() => process.exit(0), 3000);
      force.unref();
      const closing = app.close();
      app.server.closeAllConnections();
      await closing.catch(() => {});
      db.close();
      brainLock?.stop();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  } catch (error) {
    brainLock?.stop();
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
