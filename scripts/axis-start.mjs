import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dotnet, ensureRuntime, env, listening, ownedProcess, pause, pidPath, root, runtime, services } from './axis-common.mjs';

ensureRuntime();
if (!existsSync(join(runtime, 'seeded.json'))) throw new Error('Run npm run axis:bootstrap first.');

for (const service of services) {
  const existing = ownedProcess(service.name);
  if (existing && await listening(service.port)) {
    console.log(`${service.name}: already running (PID ${existing.pid}), 127.0.0.1:${service.port}`);
    continue;
  }
  if (await listening(service.port)) throw new Error(`Port ${service.port} is occupied by another process; preserving it.`);
  const identity = service.dll ? join(runtime, 'bin', service.name, service.dll) : join(root, 'scripts', 'axis-assets.mjs');
  const command = service.dll ? dotnet : process.execPath;
  const args = service.dll ? [identity, `--working-dir=${join(runtime, service.name)}`, ...(service.name === 'world' ? ['--headless'] : [])] : [identity];
  const logPath = join(runtime, 'logs', `${service.name}.log`);
  const logStart = existsSync(logPath) ? statSync(logPath).size : 0;
  const log = openSync(logPath, 'a', 0o600);
  const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', log, log] });
  closeSync(log);
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  writeFileSync(pidPath(service.name), JSON.stringify({ pid: child.pid, identity, started: new Date().toISOString() }, null, 2));
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (await listening(service.port)) {
      // A World listener can be up even when its Universe authentication failed.
      if (service.name !== 'world' || readFileSync(logPath).subarray(logStart).toString().includes('Started world Haven:')) {
        ready = true; break;
      }
    }
    if (!ownedProcess(service.name)) break;
    await pause(250);
  }
  if (!ready) throw new Error(`${service.name} did not start; inspect ${logPath}`);
  console.log(`${service.name}: PID ${child.pid}, 127.0.0.1:${service.port}; log ${logPath}`);
}
