#!/usr/bin/env bun

import { loadConfig } from './config';
import { RuntimeRegistry } from './core/runtime-registry';
import { GitHubClient } from './github/client';
import { createLogger } from './util/logger';

const logger = createLogger({ service: 'orbit-pilot' });

async function main() {
  const { once, configPath } = parseArgs(process.argv.slice(2));
  const { config, path } = await loadConfig(configPath);
  const client = new GitHubClient();

  logger.info('starting', {
    once,
    configPath: path,
  });

  const registry = new RuntimeRegistry(config, client, logger);
  await registry.startAll(once);
}

function parseArgs(args: string[]) {
  let once = false;
  let configPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if (value === '--once') {
      once = true;
      continue;
    }

    if (value === '--config') {
      configPath = args[index + 1];
      index += 1;
      continue;
    }

    throw new Error(`unknown argument: ${value}`);
  }

  return { once, configPath };
}

await main();
