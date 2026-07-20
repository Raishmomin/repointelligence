// ═══════════════════════════════════════════════════════════════
// Logger — Structured logging via VS Code OutputChannel
// ═══════════════════════════════════════════════════════════════

import * as vscode from 'vscode';
import { EXTENSION_NAME } from './constants';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Centralized logger that writes to a VS Code OutputChannel.
 * Supports structured metadata and configurable log levels.
 *
 * Usage:
 *   Logger.info('Scan complete', { files: 342, duration: '2.1s' });
 */
export class Logger {
  private static instance: Logger;
  private outputChannel: vscode.OutputChannel;
  private level: LogLevel = LogLevel.INFO;

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);
  }

  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, meta);
  }

  error(message: string, error?: Error | unknown, meta?: Record<string, unknown>): void {
    const errorMeta = { ...meta };
    if (error instanceof Error) {
      errorMeta.errorName = error.name;
      errorMeta.errorMessage = error.message;
      errorMeta.stack = error.stack;
    }
    this.log(LogLevel.ERROR, message, errorMeta);
  }

  show(): void {
    this.outputChannel.show(true);
  }

  dispose(): void {
    this.outputChannel.dispose();
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (level < this.level) {
      return;
    }

    const timestamp = new Date().toISOString();
    const levelStr = LogLevel[level].padEnd(5);
    let line = `[${timestamp}] [${levelStr}] ${message}`;

    if (meta && Object.keys(meta).length > 0) {
      line += ` | ${JSON.stringify(meta)}`;
    }

    this.outputChannel.appendLine(line);

    // Also log errors to the console for debugging in Extension Development Host
    if (level === LogLevel.ERROR) {
      console.error(`[${EXTENSION_NAME}]`, message, meta);
    }
  }
}
