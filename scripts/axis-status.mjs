import { listening, ownedProcess, runtime, services } from './axis-common.mjs';
for (const service of services) {
  const owned = ownedProcess(service.name);
  const port = await listening(service.port);
  console.log(`${service.name}: process=${owned ? owned.pid : 'stopped'} listener=${port ? 'active' : 'inactive'} address=127.0.0.1:${service.port}${port && !owned ? ' (not owned by this fixture)' : ''}`);
  if (!owned || !port) process.exitCode = 1;
}
console.log(`Data and logs: ${runtime}`);
