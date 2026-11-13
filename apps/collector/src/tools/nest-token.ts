/**
 * The one-off Nest consent step (docs/06 § 5b): turns the address Google redirected to after
 * "Allow" into the refresh token for NEST_REFRESH_TOKEN. Uses NEST_CLIENT_ID and
 * NEST_CLIENT_SECRET from .env. On the Pi, within a few minutes of authorising:
 *   docker compose exec collector node dist/tools/nest-token.js 'https://www.google.com/?code=…'
 */
import { loadCollectorEnv, requireSetting } from '../env.js';
import { codeFromRedirect, exchangeAuthorizationCode } from '../sources/nest/auth.js';

const env = loadCollectorEnv(process.env);
try {
  const token = await exchangeAuthorizationCode(
    {
      clientId: requireSetting(env.NEST_CLIENT_ID, 'NEST_CLIENT_ID'),
      clientSecret: requireSetting(env.NEST_CLIENT_SECRET, 'NEST_CLIENT_SECRET'),
    },
    codeFromRedirect(process.argv[2] ?? ''),
    AbortSignal.timeout(30_000),
  );
  console.log('Put this in .env as NEST_REFRESH_TOKEN (keep it private):\n');
  console.log(token);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
