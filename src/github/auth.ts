import { readFileSync } from 'node:fs';
import { createAppAuth } from '@octokit/auth-app';

export type AuthMode = 'pat' | 'app';

export interface ResolvedAuth {
  mode: AuthMode;
  /** Options to spread into the Octokit constructor. */
  options: Record<string, unknown>;
  /** Human-readable description for `doctor` output. */
  description: string;
}

/**
 * Resolve credentials from the environment, preferring a GitHub App when one is
 * configured.
 *
 * Both paths exist deliberately: a PAT is the zero-setup option for a local
 * run, but it belongs to whoever is coordinating this semester and dies when
 * they graduate. An org-owned App survives staff turnover, which is the failure
 * mode that left the previous tool unmaintained.
 */
export function resolveAuth(env: NodeJS.ProcessEnv = process.env): ResolvedAuth {
  const appId = env.GITHUB_APP_ID?.trim();
  const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim();
  const privateKey = readPrivateKey(env);

  if (appId && installationId && privateKey) {
    return {
      mode: 'app',
      options: {
        authStrategy: createAppAuth,
        auth: { appId, privateKey, installationId },
      },
      description: `GitHub App ${appId} (installation ${installationId})`,
    };
  }

  const token = env.GITHUB_TOKEN?.trim();
  if (token) {
    return { mode: 'pat', options: { auth: token }, description: 'personal access token' };
  }

  const partial = [appId && 'GITHUB_APP_ID', installationId && 'GITHUB_APP_INSTALLATION_ID', privateKey && 'a private key'].filter(Boolean);
  const hint =
    partial.length > 0
      ? ` Found ${partial.join(', ')} but the App configuration is incomplete.`
      : '';
  throw new Error(
    `No GitHub credentials found. Set GITHUB_TOKEN, or all of GITHUB_APP_ID, ` +
      `GITHUB_APP_INSTALLATION_ID and GITHUB_APP_PRIVATE_KEY (or _PATH).${hint}`,
  );
}

function readPrivateKey(env: NodeJS.ProcessEnv): string | null {
  const inline = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (inline) return inline.replace(/\\n/g, '\n');
  const path = env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  if (!path) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Could not read GitHub App private key at "${path}".`);
  }
}
