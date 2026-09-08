import { unlinkSync } from 'node:fs';
import { listening, ownedProcess, pause, pidPath, readPid, services } from './axis-common.mjs';

for (const service of [...services].reverse()) {
  const record = ownedProcess(service.name);
  if (!record) {
    if (readPid(service.name)) console.log(`${service.name}: saved PID is not an owned running process; no signal sent.`);
    continue;
  }
  process.kill(record.pid, 'SIGTERM');
  for (let i = 0; i < 40 && ownedProcess(service.name); i++) await pause(250);
  if (ownedProcess(service.name)) throw new Error(`${service.name} is still exiting (PID ${record.pid}); inspect its log.`);
  unlinkSync(pidPath(service.name));
  console.log(`${service.name}: stopped; listener=${await listening(service.port) ? 'still occupied' : 'inactive'}. Data retained.`);
}
