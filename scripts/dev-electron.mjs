import { spawn } from 'node:child_process';
import { once } from 'node:events';
import process from 'node:process';

const children = [];

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
  const tsc = start('npx', ['tsc', '-p', 'tsconfig.electron.json', '--watch', '--preserveWatchOutput']);
  const vite = start('npx', ['vite']);

  await once(vite, 'spawn');

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
