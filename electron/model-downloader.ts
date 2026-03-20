import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile, execFileSync, spawn } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';

const SENSEVOICE_MODEL_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const SENSEVOICE_ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2';
const WHISPER_TINY_EN_MODEL_DIR = 'sherpa-onnx-whisper-tiny.en';
const WHISPER_TINY_EN_ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-tiny.en.tar.bz2';
const WHISPER_SMALL_MODEL_DIR = 'sherpa-onnx-whisper-small';
const WHISPER_SMALL_ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-small.tar.bz2';
const ZIPFORMER_KOREAN_MODEL_DIR = 'sherpa-onnx-zipformer-korean-2024-06-24';
const ZIPFORMER_KOREAN_ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-zipformer-korean-2024-06-24.tar.bz2';
const VAD_MODEL_FILE = 'silero_vad.onnx';
const VAD_MODEL_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';
const DEFAULT_MLX_WHISPER_MODEL = process.env.BICAPTION_MLX_WHISPER_MODEL || 'mlx-community/whisper-large-v3-turbo';

export interface ModelStatus {
  sensevoice: boolean;
  mlxWhisper: boolean;
  whisperTinyEn: boolean;
  whisperSmall: boolean;
  zipformerKo: boolean;
  vad: boolean;
  ready: boolean;
}

export interface ModelDownloadProgress {
  stage: 'sensevoice' | 'mlx-whisper' | 'whisper-tiny-en' | 'whisper-small' | 'zipformer-ko' | 'vad' | 'extracting';
  percent: number;
  downloadedMB: number;
  totalMB: number;
}

export class ModelDownloader extends EventEmitter {
  private pythonDir: string;
  private aborted = false;

  /**
   * @param modelDir - Directory where models are stored.
   *   In dev: projectRoot/python. In production: userData/models.
   */
  constructor(modelDir: string) {
    super();
    this.pythonDir = modelDir;
  }

  checkStatus(): ModelStatus {
    const sensevoice = existsSync(join(this.pythonDir, SENSEVOICE_MODEL_DIR, 'model.int8.onnx'));
    const mlxWhisper = this.checkPythonPackage('mlx-whisper') && this.checkMlxWhisperModelReady(DEFAULT_MLX_WHISPER_MODEL);
    const whisperTinyEn = existsSync(join(this.pythonDir, WHISPER_TINY_EN_MODEL_DIR, 'tiny.en-encoder.int8.onnx'));
    const whisperSmall = existsSync(join(this.pythonDir, WHISPER_SMALL_MODEL_DIR, 'small-encoder.int8.onnx'));
    const zipformerKo = existsSync(join(this.pythonDir, ZIPFORMER_KOREAN_MODEL_DIR, 'encoder-epoch-99-avg-1.int8.onnx'));
    const vad = existsSync(join(this.pythonDir, VAD_MODEL_FILE));
    return { sensevoice, mlxWhisper, whisperTinyEn, whisperSmall, zipformerKo, vad, ready: (sensevoice || mlxWhisper || whisperTinyEn || whisperSmall || zipformerKo) && vad };
  }

  abort() {
    this.aborted = true;
  }

  private static readonly MODEL_MAP: Record<string, { dir?: string; file?: string; url?: string; stage: 'sensevoice' | 'mlx-whisper' | 'whisper-tiny-en' | 'whisper-small' | 'zipformer-ko' | 'vad'; isArchive: boolean; isPythonPackage?: boolean; packageName?: string }> = {
    sensevoice: { dir: SENSEVOICE_MODEL_DIR, url: SENSEVOICE_ARCHIVE_URL, stage: 'sensevoice', isArchive: true },
    'mlx-whisper': { stage: 'mlx-whisper', isArchive: false, isPythonPackage: true, packageName: 'mlx-whisper' },
    'whisper-tiny-en': { dir: WHISPER_TINY_EN_MODEL_DIR, url: WHISPER_TINY_EN_ARCHIVE_URL, stage: 'whisper-tiny-en', isArchive: true },
    'whisper-small': { dir: WHISPER_SMALL_MODEL_DIR, url: WHISPER_SMALL_ARCHIVE_URL, stage: 'whisper-small', isArchive: true },
    'zipformer-ko': { dir: ZIPFORMER_KOREAN_MODEL_DIR, url: ZIPFORMER_KOREAN_ARCHIVE_URL, stage: 'zipformer-ko', isArchive: true },
    vad: { file: VAD_MODEL_FILE, url: VAD_MODEL_URL, stage: 'vad', isArchive: false },
  };

  async downloadOne(modelKey: string): Promise<void> {
    this.aborted = false;
    const entry = ModelDownloader.MODEL_MAP[modelKey];
    if (!entry) throw new Error(`Unknown model: ${modelKey}`);

    if (entry.isPythonPackage) {
      await this.installPythonPackage(entry.packageName!, 'mlx-whisper');
      if (this.aborted) return;
      await this.prepareMlxWhisperModel(DEFAULT_MLX_WHISPER_MODEL, 'mlx-whisper');
    } else if (entry.isArchive) {
      const archiveName = `${modelKey}.tar.bz2`;
      const archivePath = join(this.pythonDir, archiveName);
      await this.downloadFile(entry.url!, archivePath, entry.stage);
      if (this.aborted) return;
      this.emitProgress({ stage: 'extracting', percent: 0, downloadedMB: 0, totalMB: 0 });
      await this.extractTarBz2(archivePath, this.pythonDir);
      try { rmSync(archivePath); } catch {}
    } else {
      await this.downloadFile(entry.url!, join(this.pythonDir, entry.file!), entry.stage);
    }

    if (!this.aborted) {
      this.emit('done', this.checkStatus());
    }
  }

  async downloadAll(): Promise<void> {
    this.aborted = false;
    const status = this.checkStatus();

    if (!status.vad) {
      await this.downloadFile(VAD_MODEL_URL, join(this.pythonDir, VAD_MODEL_FILE), 'vad');
      if (this.aborted) return;
    }

    if (!status.mlxWhisper) {
      await this.installPythonPackage('mlx-whisper', 'mlx-whisper');
      if (this.aborted) return;
      await this.prepareMlxWhisperModel(DEFAULT_MLX_WHISPER_MODEL, 'mlx-whisper');
      if (this.aborted) return;
    }

    if (!status.sensevoice) {
      const archivePath = join(this.pythonDir, 'sensevoice.tar.bz2');
      await this.downloadFile(SENSEVOICE_ARCHIVE_URL, archivePath, 'sensevoice');
      if (this.aborted) return;

      this.emitProgress({ stage: 'extracting', percent: 0, downloadedMB: 0, totalMB: 0 });
      await this.extractTarBz2(archivePath, this.pythonDir);
      try {
        rmSync(archivePath);
      } catch {}
    }

    if (!status.whisperTinyEn) {
      const archivePath = join(this.pythonDir, 'whisper-tiny-en.tar.bz2');
      await this.downloadFile(WHISPER_TINY_EN_ARCHIVE_URL, archivePath, 'whisper-tiny-en');
      if (this.aborted) return;

      this.emitProgress({ stage: 'extracting', percent: 0, downloadedMB: 0, totalMB: 0 });
      await this.extractTarBz2(archivePath, this.pythonDir);
      try {
        rmSync(archivePath);
      } catch {}
    }

    if (!status.whisperSmall) {
      const archivePath = join(this.pythonDir, 'whisper-small.tar.bz2');
      await this.downloadFile(WHISPER_SMALL_ARCHIVE_URL, archivePath, 'whisper-small');
      if (this.aborted) return;

      this.emitProgress({ stage: 'extracting', percent: 0, downloadedMB: 0, totalMB: 0 });
      await this.extractTarBz2(archivePath, this.pythonDir);
      try {
        rmSync(archivePath);
      } catch {}
    }

    if (!status.zipformerKo) {
      const archivePath = join(this.pythonDir, 'zipformer-ko.tar.bz2');
      await this.downloadFile(ZIPFORMER_KOREAN_ARCHIVE_URL, archivePath, 'zipformer-ko');
      if (this.aborted) return;

      this.emitProgress({ stage: 'extracting', percent: 0, downloadedMB: 0, totalMB: 0 });
      await this.extractTarBz2(archivePath, this.pythonDir);
      try {
        rmSync(archivePath);
      } catch {}
    }

    if (!this.aborted) {
      this.emit('done', this.checkStatus());
    }
  }

  private emitProgress(progress: ModelDownloadProgress) {
    this.emit('progress', progress);
  }

  private downloadFile(url: string, dest: string, stage: 'sensevoice' | 'mlx-whisper' | 'whisper-tiny-en' | 'whisper-small' | 'zipformer-ko' | 'vad'): Promise<void> {
    return new Promise((resolve, reject) => {
      const tmpDest = dest + '.tmp';
      const doRequest = (requestUrl: string) => {
        const mod = requestUrl.startsWith('https') ? https : http;
        mod.get(requestUrl, (res: any) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            doRequest(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} downloading ${stage}`));
            return;
          }

          const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
          let downloadedBytes = 0;
          const file = createWriteStream(tmpDest);

          res.on('data', (chunk: Buffer) => {
            if (this.aborted) {
              res.destroy();
              file.close();
              try { rmSync(tmpDest); } catch {}
              return;
            }
            downloadedBytes += chunk.length;
            file.write(chunk);
            this.emitProgress({
              stage,
              percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
              downloadedMB: Math.round(downloadedBytes / 1048576),
              totalMB: Math.round(totalBytes / 1048576),
            });
          });

          res.on('end', () => {
            file.end(() => {
              if (!this.aborted) {
                renameSync(tmpDest, dest);
              }
              resolve();
            });
          });

          res.on('error', (err: Error) => {
            file.close();
            try { rmSync(tmpDest); } catch {}
            reject(err);
          });
        }).on('error', reject);
      };
      doRequest(url);
    });
  }

  private extractTarBz2(archivePath: string, cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('tar', ['xjf', archivePath], { cwd }, (error) => {
        if (error) {
          reject(new Error(`Failed to extract model archive: ${error.message}`));
        } else {
          this.emitProgress({ stage: 'extracting', percent: 100, downloadedMB: 0, totalMB: 0 });
          resolve();
        }
      });
    });
  }

  private getPythonCommand(): string {
    const venvPython = join(process.cwd(), '.venv', 'bin', 'python');
    return existsSync(venvPython) ? venvPython : 'python3';
  }

  private checkPythonPackage(packageName: string): boolean {
    try {
      execFileSync(this.getPythonCommand(), ['-c', `from importlib.metadata import version; version(${JSON.stringify(packageName)})`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private installPythonPackage(packageName: string, stage: 'mlx-whisper'): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = this.getPythonCommand();
      this.emitProgress({ stage, percent: 5, downloadedMB: 0, totalMB: 0 });
      const child = spawn(command, ['-m', 'pip', 'install', packageName], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', () => {
        this.emitProgress({ stage, percent: 60, downloadedMB: 0, totalMB: 0 });
      });
      child.stderr.on('data', () => {
        this.emitProgress({ stage, percent: 60, downloadedMB: 0, totalMB: 0 });
      });
      child.on('exit', (code) => {
        if (code === 0) {
          this.emitProgress({ stage, percent: 100, downloadedMB: 0, totalMB: 0 });
          resolve();
        } else {
          reject(new Error(`Failed to install ${packageName}`));
        }
      });
      child.on('error', reject);
    });
  }

  private checkMlxWhisperModelReady(modelId: string): boolean {
    try {
      execFileSync(this.getPythonCommand(), [
        '-c',
        [
          'import sys',
          'from huggingface_hub import snapshot_download',
          'snapshot_download(repo_id=sys.argv[1], local_files_only=True)',
        ].join('; '),
        modelId,
      ], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private prepareMlxWhisperModel(modelId: string, stage: 'mlx-whisper'): Promise<void> {
    return new Promise((resolve, reject) => {
      const command = this.getPythonCommand();
      this.emitProgress({ stage, percent: 40, downloadedMB: 0, totalMB: 0 });
      const child = spawn(command, [
        '-c',
        [
          'import sys',
          'from huggingface_hub import snapshot_download',
          'snapshot_download(repo_id=sys.argv[1])',
        ].join('; '),
        modelId,
      ], {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', () => {
        this.emitProgress({ stage, percent: 80, downloadedMB: 0, totalMB: 0 });
      });
      child.stderr.on('data', () => {
        this.emitProgress({ stage, percent: 80, downloadedMB: 0, totalMB: 0 });
      });
      child.on('exit', (code) => {
        if (code === 0) {
          this.emitProgress({ stage, percent: 100, downloadedMB: 0, totalMB: 0 });
          resolve();
        } else {
          reject(new Error(`Failed to prepare MLX Whisper model ${modelId}`));
        }
      });
      child.on('error', reject);
    });
  }
}
