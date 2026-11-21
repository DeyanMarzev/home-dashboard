/**
 * Prints a new VAPID key pair as .env lines (docs/06 § 10). Run once on the Pi:
 *   docker compose run --rm -T --no-deps api node dist/tools/generate-vapid-keys.js >> .env
 * Changing the keys later makes every phone turn notifications on again.
 */
import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
process.stdout.write(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\n`);
