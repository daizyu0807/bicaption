import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
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

export interface ModelStatus {
  sensevoice: boolean;
  whisperTinyEn: boolean;
  whisperSmall: boolean;
  zipformerKo: boolean;
  vad: boolean;
  ready: boolean;
}

export interface ModelDownloadProgress {
  stage: 'sensevoice' | 'whisper-tiny-en' | 'whisper-small' | 'zipformer-ko' | 'vad' | 'extracting';
  percent: number;
  downloadedMB: number;
  totalMB: number;
}

export class ModelDownloader extends EventEmitter {
  private pythonDir: string;
  private aborted = false;

  constructor(projectRoot: string) {
    super();
    this.pythonDir = join(projectRoot, 'python');
  }

  checkStatus(): ModelStatus {
    const sensevoice = existsSync(join(this.pythonDir, SENSEVOICE_MODEL_DIR, 'model.int8.onnx'));
    const whisperTinyEn = existsSync(join(this.pythonDir, WHISPER_TINY_EN_MODEL_DIR, 'tiny.en-encoder.int8.onnx'));
    const whisperSmall = existsSync(join(this.pythonDir, WHISPER_SMALL_MODEL_DIR, 'small-encoder.int8.onnx'));
    const zipformerKo = existsSync(join(this.pythonDir, ZIPFORMER_KOREAN_MODEL_DIR, 'encoder-epoch-99-avg-1.int8.onnx'));
    const vad = existsSync(join(this.pythonDir, VAD_MODEL_FILE));
    return { sensevoice, whisperTinyEn, whisperSmall, zipformerKo, vad, ready: (sensevoice || whisperTinyEn || whisperSmall || zipformerKo) && vad };
  }

  abort() {
    this.aborted = true;
  }

  async downloadAll(): Promise<void> {
    this.aborted = false;
    const status = this.checkStatus();

    if (!status.vad) {
      await this.downloadFile(VAD_MODEL_URL, join(this.pythonDir, VAD_MODEL_FILE), 'vad');
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

  private downloadFile(url: string, dest: string, stage: 'sensevoice' | 'whisper-tiny-en' | 'whisper-small' | 'zipformer-ko' | 'vad'): Promise<void> {
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
}
