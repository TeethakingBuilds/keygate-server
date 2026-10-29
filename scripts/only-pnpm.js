/**
 * Lockstep: this repo is pnpm-only because the lockfile is what makes CI and a
 * contributor's machine resolve the same transitive versions. npm/yarn would
 * silently ignore `pnpm-lock.yaml`.
 */
const userAgent = process.env.npm_config_user_agent ?? '';

if (!userAgent.includes('pnpm')) {
  console.error(
    [
      'keygate-server uses pnpm.',
      '',
      '  corepack enable',
      '  pnpm install',
      '',
      'If corepack is unavailable: npm install -g pnpm',
    ].join('\n'),
  );
  process.exit(1);
}
