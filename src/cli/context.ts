import { loadConfig, prefixOf, type CourseConfig } from '../core/config.js';
import { openDb, type Db } from '../db/index.js';
import { createClient, type GitHubClient } from '../github/client.js';

export interface GlobalOptions {
  config: string;
  roster?: string;
  db?: string;
}

export interface Context {
  config: CourseConfig;
  prefix: string;
  rosterPath: string;
  db: Db;
}

export function buildContext(options: GlobalOptions): Context {
  const config = loadConfig(options.config);
  return {
    config,
    prefix: prefixOf(config),
    rosterPath: options.roster ?? config.roster,
    db: openDb(options.db ?? config.databasePath),
  };
}

/** Identify who the run is acting as. Installation tokens have no user. */
export async function whoami(client: GitHubClient): Promise<string | null> {
  if (client.auth.mode === 'app') return null;
  try {
    const { data } = await client.octokit.request('GET /user');
    return data.login;
  } catch {
    return null;
  }
}

export { createClient };
