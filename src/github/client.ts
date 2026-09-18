import { Octokit } from 'octokit';
import { resolveAuth, type ResolvedAuth } from './auth.js';

export interface GitHubClient {
  octokit: Octokit;
  auth: ResolvedAuth;
}

/**
 * Build an Octokit client with retry and throttling enabled.
 *
 * The `octokit` package ships the throttling and retry plugins preconfigured,
 * so secondary rate limits — the "endpoint has been spammed" 422/403 the old
 * script tried and failed to detect by hand — are backed off automatically
 * instead of surfacing as a mid-run explosion.
 */
export function createClient(log: (message: string) => void = console.warn): GitHubClient {
  const auth = resolveAuth();
  const octokit = new Octokit({
    ...auth.options,
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
