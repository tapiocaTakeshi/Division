import fs from "fs";
import path from "path";

// Vercel serverless: /var/task is read-only, use /tmp for logs
const isVercel = !!process.env.VERCEL;
const LOG_DIR = isVercel
  ? "/tmp/logs"
  : path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "ai.log");

// Ensure log directory exists (silently skip on failure)
let canWriteFile = false;
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
  canWriteFile = true;
} catch {
  // Filesystem not writable — console-only logging
  canWriteFile = false;
}

export enum LogLevel {
  INFO = "INFO",
  WARN = "WARN",
  ERROR = "ERROR",
  DEBUG = "DEBUG",
}

class Logger {
  private static instance: Logger;

  private constructor() {}

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private formatMessage(level: LogLevel, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` | Data: ${JSON.stringify(data)}` : "";
    return `[${timestamp}] [${level}] ${message}${dataStr}`;
  }

  private write(level: LogLevel, message: string, data?: any) {
    const formatted = this.formatMessage(level, message, data);
    
    // Always log to console
    if (level === LogLevel.ERROR) {
      console.error(formatted);
    } else if (level === LogLevel.WARN) {
      console.warn(formatted);
    } else {
      console.log(formatted);
    }

    // Append to file (only if writable)
    if (canWriteFile) {
      try {
        fs.appendFileSync(LOG_FILE, formatted + "\n");
      } catch {
        // Silently ignore file write errors
      }
    }
  }

  public info(message: string, data?: any) {
    this.write(LogLevel.INFO, message, data);
  }

  public warn(message: string, data?: any) {
    this.write(LogLevel.WARN, message, data);
  }

  public error(message: string, data?: any) {
    this.write(LogLevel.ERROR, message, data);
  }

  public debug(message: string, data?: any) {
    this.write(LogLevel.DEBUG, message, data);
  }
}

export const logger = Logger.getInstance();
