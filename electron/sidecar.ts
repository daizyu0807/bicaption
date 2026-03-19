import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaptionConfig, SidecarEvent } from './types.js';
import { getSidecarCommand, getModelDir, getSpawnCwd } from './paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ignoredStderrPatterns = [
  'Disabling PyTorch because PyTorch >= 2.4 is required but found 2.2.2',
  'PyTorch was not found. Models won\'t be available',
];
const ignoredStdoutPatterns = [
  'Intel MKL',
  'OMP:',
  'OpenMP',
  'MKL_VERBOSE',
];

interface SidecarCommand {
  command: 'start_session' | 'stop_session' | 'ping';
  payload: Record<string, unknown> | CaptionConfig;
}

export class SidecarBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pendingStopPromise: Promise<void> | null = null;
  private resolvePendingStop: (() => void) | null = null;

  start() {
    if (this.child) {
      return;
    }

    const { command, args: spawnArgs } = getSidecarCommand();
    const child = spawn(command, spawnArgs, {
      cwd: getSpawnCwd(),
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        USE_TORCH: '0',
        KMP_WARNINGS: '0',
        MKL_VERBOSE: '0',
        BICAPTION_MODEL_DIR: getModelDir(),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    const lineReader = createInterface({ input: child.stdout });
    lineReader.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      if (ignoredStdoutPatterns.some((pattern) => trimmed.includes(pattern))) {
        return;
      }
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        this.emit('error', {
          type: 'error',
          mode: 'subtitle',
          sessionId: 'sidecar-bridge',
          code: 'sidecar_stdout',
          message: trimmed,
          recoverable: true,
        } satisfies SidecarEvent);
        return;
      }
      try {
        const event = JSON.parse(trimmed) as SidecarEvent;
        if (event.type === 'session_stopped_ack') {
          this.finishPendingStop();
        }
        this.emit(event.type, event);
        this.emit('event', event);
      } catch (error) {
        this.emit('error', {
          type: 'error',
          mode: 'subtitle',
          sessionId: 'sidecar-bridge',
          code: 'sidecar_parse_error',
          message: `${error instanceof Error ? error.message : 'Unknown sidecar parse error'}: ${trimmed.slice(0, 160)}`,
          recoverable: true,
        } satisfies SidecarEvent);
      }
    });

    const errorReader = createInterface({ input: child.stderr });
    errorReader.on('line', (line) => {
      if (!line.trim()) {
        return;
      }
      if (ignoredStderrPatterns.some((pattern) => line.includes(pattern))) {
        return;
      }
      this.emit('error', {
        type: 'error',
        mode: 'subtitle',
        sessionId: 'sidecar-bridge',
        code: 'sidecar_stderr',
        message: line,
        recoverable: true,
      } satisfies SidecarEvent);
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      this.finishPendingStop();
      this.emit('session_state', {
        type: 'session_state',
        mode: 'subtitle',
        sessionId: 'sidecar-exit',
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
    if (!this.child) {
      return Promise.resolve();
    }
    if (this.pendingStopPromise) {
      return this.pendingStopPromise;
    }
    this.pendingStopPromise = new Promise<void>((resolve) => {
      this.resolvePendingStop = resolve;
    });
    this.send({ command: 'stop_session', payload: {} });
    return this.pendingStopPromise;
  }

  ping() {
    this.send({ command: 'ping', payload: {} });
  }

  dispose() {
    void this.stopSession();
    this.child?.kill('SIGTERM');
    this.child = null;
    this.finishPendingStop();
  }

  private finishPendingStop() {
    this.resolvePendingStop?.();
    this.resolvePendingStop = null;
    this.pendingStopPromise = null;
  }
}
