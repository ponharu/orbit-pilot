import type { AppConfig } from '../config';
import { GitHubClient } from '../github/client';
import { createLogger } from '../util/logger';
import type { Logger } from './types';
import { AgentRunner } from './agent-runner';
import { RepositoryRuntime } from './repository-runtime';
import { StateStore } from './state-store';
import { WorkspaceManager } from './workspace-manager';

export class RuntimeRegistry {
  private readonly runtimes = new Map<string, RepositoryRuntime>();
  private readonly workspaceManager: WorkspaceManager;
  private readonly stateStore: StateStore;
  private readonly runner: AgentRunner;
  private readonly logger: Logger;

  constructor(
    private readonly config: AppConfig,
    private readonly client: GitHubClient,
    logger: Logger,
  ) {
    this.logger = logger;
    this.workspaceManager = new WorkspaceManager(config, logger);
    this.stateStore = new StateStore(config);
    this.runner = new AgentRunner(config, logger, this.workspaceManager);
  }

  async startAll(once: boolean) {
    const viewerLogin = await this.client.getViewerLogin();
    const repositories = await this.client.listRepositories(this.config.owners, this.config.excludeRepos);

    this.logger.info('discovered repositories', {
      owners: this.config.owners,
      excludeRepos: this.config.excludeRepos,
      viewerLogin,
      repositoryCount: repositories.length,
    });

    for (const target of repositories) {
      const runtimeLogger = createLogger({ repo: target.fullName });
      const runtime = new RepositoryRuntime(
        this.config,
        target,
        viewerLogin,
        this.client,
        this.runner,
        this.stateStore,
        runtimeLogger,
        !once,
      );
      this.runtimes.set(target.fullName, runtime);
      await runtime.start();
    }

    if (once) {
      return;
    }

    await new Promise(() => undefined);
  }
}
