import { Octokit } from 'octokit';
import { resolveAuth, type ResolvedAuth } from './auth.js';

export interface GitHubClient {
  octokit: Octokit;
  auth: ResolvedAuth;
}

const PUBLIC_API = 'https://api.github.com';

/**
 * Build an Octokit client with retry and throttling enabled.
 *
 * The `octokit` package ships the throttling and retry plugins preconfigured,
 * so both primary and secondary rate limits are backed off and retried rather
 * than surfacing as a failure partway through a run.
 *
 * `GITHUB_API_URL` overrides the API host. GitHub Actions and the `gh` CLI
 * already set it, GitHub Enterprise Server deployments need it, and the
 * end-to-end tests use it to point at a local stub.
 */
export function createClient(log: (message: string) => void = console.warn): GitHubClient {
  const auth = resolveAuth();
  const octokit = new Octokit({
    ...auth.options,
    baseUrl: process.env.GITHUB_API_URL?.trim().replace(/\/$/, '') || PUBLIC_API,
    userAgent: 'auto-repo/2.0',
    throttle: {
      onRateLimit(retryAfter: number, options: { method: string; url: string }, _o: unknown, retryCount: number) {
        log(`Rate limit hit on ${options.method} ${options.url}; retrying in ${retryAfter}s.`);
        return retryCount < 3;
      },
      onSecondaryRateLimit(retryAfter: number, options: { method: string; url: string }, _o: unknown, retryCount: number) {
        log(`Secondary rate limit on ${options.method} ${options.url}; retrying in ${retryAfter}s.`);
        return retryCount < 3;
      },
    },
  });
  return { octokit, auth };
}
