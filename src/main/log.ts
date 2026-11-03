/**
 * Tiny file logger: userData/logs/app.log, rotated at 1 MB (one previous file kept).
 * Used for anything that would help debug "it doesn't connect" reports:
 * discovery activity, driver errors, updater errors, uncaught exceptions.
 */
import { app } from 'electron';
import fs from 'fs';
import path from 'path';

const MAX_BYTES = 1024 * 1024;
let file: string | undefined;

export function logPath(): string {
  if (!file) {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'app.log');
  }
  return file;
}

function write(level: string, tag: string, message: string): void {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${tag}] ${message}\n`;
  try {
    const p = logPath();
    try {
      if (fs.statSync(p).size > MAX_BYTES) fs.renameSync(p, p.replace(/\.log$/, '.1.log'));
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(p, line);
  } catch {
    /* logging must never throw */
  }
  if (process.argv.includes('--dev')) process.stderr.write(line);
}

export const log = {
  info: (tag: string, message: string) => write('info', tag, message),
  warn: (tag: string, message: string) => write('warn', tag, message),
  error: (tag: string, message: string) => write('error', tag, message),
};

export function installCrashLogging(): void {
  process.on('uncaughtException', (err) => log.error('process', `uncaught: ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (reason) => log.error('process', `unhandled rejection: ${(reason as Error)?.stack ?? String(reason)}`));
}
