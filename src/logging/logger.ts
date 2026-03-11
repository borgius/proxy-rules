import picocolors from "picocolors";
import type { LoggingConfig } from "../config/schema.ts";
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function timestamp(): string {
  return new Date().toISOString();
}

export class Logger {
  private config: LoggingConfig;
  private fileHandle: string | undefined;

  constructor(config: LoggingConfig) {
    this.config = config;
    if (config.outputPath) {
      const dir = dirname(config.outputPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      this.fileHandle = config.outputPath;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.config.level];
  }

  private formatPretty(level: LogLevel, msg: string, data?: Record<string, unknown>): string {
    const ts = timestamp();
    const color =
      level === "error" ? picocolors.red :
      level === "warn" ? picocolors.yellow :
      level === "info" ? picocolors.cyan :
      picocolors.gray;
    const prefix = color(`[${level.toUpperCase()}]`);
    const suffix = data ? ` ${JSON.stringify(data)}` : "";
    return `${picocolors.dim(ts)} ${prefix} ${msg}${suffix}`;
  }

  private formatJson(level: LogLevel, msg: string, data?: Record<string, unknown>): string {
    return JSON.stringify({ ts: timestamp(), level, msg, ...data });
  }

  private emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const line =
      this.config.format === "json"
        ? this.formatJson(level, msg, data)
        : this.formatPretty(level, msg, data);

    if (level === "error" || level === "warn") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }

    if (this.fileHandle) {
      appendFileSync(this.fileHandle, this.formatJson(level, msg, data) + "\n");
    }
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.emit("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.emit("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.emit("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.emit("error", msg, data);
  }
}

// Singleton – initialised by the serve/tls command entrypoints before any proxy code runs.
let _logger: Logger | null = null;

export function initLogger(config: LoggingConfig): Logger {
  _logger = new Logger(config);
  return _logger;
}

export function getLogger(): Logger {
  if (!_logger) {
    // Fallback during startup before full init
    _logger = new Logger({ level: "info", format: "pretty", maxBodyBytes: 0 });
  }
  return _logger;
}
