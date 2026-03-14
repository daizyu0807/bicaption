import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptionConfig, SidecarEvent } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '../..');
const sidecarPath = join(projectRoot, 'python', 'sidecar.py');

interface SidecarCommand {
  command: 'start_session' | 'stop_session' | 'ping';
  payload: Record<string, unknown> | CaptionConfig;
}

export class SidecarBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;

  start() {
    if (this.child) {
      return;
    }

    const child = spawn('python3', [sidecarPath], {
      cwd: projectRoot,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    const lineReader = createInterface({ input: child.stdout });
    lineReader.on('line', (line) => {
      if (!line.trim()) {
        return;
      }
      try {
        const event = JSON.parse(line) as SidecarEvent;
        this.emit(event.type, event);
        this.emit('event', event);
      } catch (error) {
        this.emit('error', {
          type: 'error',
          code: 'sidecar_parse_error',
          message: error instanceof Error ? error.message : 'Unknown sidecar parse error',
          recoverable: true,
        } satisfies SidecarEvent);
      }
    });

    const errorReader = createInterface({ input: child.stderr });
    errorReader.on('line', (line) => {
      this.emit('error', {
        type: 'error',
        code: 'sidecar_stderr',
        message: line,
        recoverable: true,
      } satisfies SidecarEvent);
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      this.emit('session_state', {
        type: 'session_state',
        state: code === 0 ? 'stopped' : 'error',
        detail: signal ? `Exited via ${signal}` : `Exited with code ${String(code)}`,
      } satisfies SidecarEvent);
    });
  }

  send(command: SidecarCommand) {
    if (!this.child) {
      this.start();
    }
    this.child?.stdin.write(`${JSON.stringify(command)}\n`);
  }

  startSession(config: CaptionConfig) {
    this.send({ command: 'start_session', payload: config });
  }

  stopSession() {
    this.send({ command: 'stop_session', payload: {} });
  }

  ping() {
    this.send({ command: 'ping', payload: {} });
  }

  dispose() {
    this.stopSession();
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}
