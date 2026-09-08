/** Add ONLY the dedicated local social fixture account using Axis's official import
 * entrypoint. This entrypoint returns before listener startup, so the user's live
 * Wayfarer session is not stopped. Existing accounts/passwords are never rewritten.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { dotnet, env, root, runtime } from './axis-common.mjs';

const database = join(runtime, 'universe', 'universe.db');
if (!existsSync(database)) throw new Error('Bootstrap the local Axis fixture before adding SocialTester.');
const query = sql => {
  const result = spawnSync('sqlite3', ['-json', database, sql], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Unable to inspect the local fixture database');
  return JSON.parse(result.stdout.trim() || '[]');
};
const marker = 'Wayfarer dedicated local social smoke fixture';
const manifest = join(runtime, 'universe', 'fixture-social-citizen.json');
const content = JSON.stringify([{ ID: 4, Name: 'SocialTester', Password: 'SocialTesterLocal42!', PrivPass: 'SocialTesterBot42!', Enabled: 1, Expiration: 2147483647, BotLimit: 3, Comment: marker }], null, 2);
const existing = query("SELECT citizen_id,citizen_name,admin_comment FROM citizen WHERE citizen_id=4 OR citizen_name='SocialTester'");
if (existing.length) {
  // Pinned CitizenRepository.Add currently drops the imported Comment field, so
  // the private exact manifest is the fixture marker rather than admin_comment.
  if (existing.length !== 1 || existing[0].citizen_id !== 4 || existing[0].citizen_name !== 'SocialTester' || !existsSync(manifest) || readFileSync(manifest, 'utf8') !== content) throw new Error('Citizen ID4 or SocialTester already belongs to another account; preserving it.');
  console.log('SocialTester #4 already provisioned; account and password preserved.');
} else {
  if (existsSync(manifest) && readFileSync(manifest, 'utf8') !== content) throw new Error('Social fixture import manifest has local edits; preserving it.');
  if (!existsSync(manifest)) writeFileSync(manifest, content, { mode: 0o600, flag: 'wx' });
  const result = spawnSync(dotnet, [join(runtime, 'bin', 'universe', 'Axis.UniverseServer.dll'), `--working-dir=${join(runtime, 'universe')}`, `--import-cit=${manifest}`], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  const rows = query("SELECT citizen_id,citizen_name,admin_comment FROM citizen WHERE citizen_id=4");
  if (result.status !== 0 || rows.length !== 1 || rows[0].citizen_name !== 'SocialTester') throw new Error('Dedicated social fixture import did not verify. Existing live services were not restarted.');
  console.log('Provisioned SocialTester #4 on the local fixture; existing accounts and services preserved.');
}
