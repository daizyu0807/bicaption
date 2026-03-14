import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const children = [];
const electronDistFiles = [
  join(process.cwd(), 'dist/electron/main.js'),
];

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  children.push(child);
  child.on('exit', (code) => {
    if (code && code !== 0) {
      process.exitCode = code;
    }
  });
  return child;
}

async function waitForElectronDist() {
  while (true) {
    try {
      await Promise.all(electronDistFiles.map((file) => access(file, constants.F_OK)));
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function stopChildren() {
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }
}

process.on('SIGINT', stopChildren);
process.on('SIGTERM', stopChildren);
process.on('exit', stopChildren);

async function main() {
  start('npx', ['tsc', '-p', 'tsconfig.electron.json']);
  const tsc = start('npx', ['tsc', '-p', 'tsconfig.electron.json', '--watch', '--preserveWatchOutput']);
  const vite = start('npx', ['vite']);

  await once(vite, 'spawn');
  await waitForElectronDist();

  const electron = start('npx', ['electron', '.'], {
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: 'http://127.0.0.1:5174',
    },
  });

  await Promise.race([
    once(electron, 'exit'),
    once(tsc, 'exit'),
    once(vite, 'exit'),
  ]);
  stopChildren();
}

main().catch((error) => {
  console.error(error);
  stopChildren();
  process.exit(1);
});
