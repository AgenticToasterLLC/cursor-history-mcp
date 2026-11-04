/**
 * Error handling module for cursor-history-mcp
 * Maps cursor-history library errors to MCP error codes
 */

import {
  isDatabaseLockedError,
  isDatabaseNotFoundError,
  isSessionNotFoundError,
  isWorkspaceNotFoundError,
  isBackupError,
  isRestoreError,
  isInvalidBackupError,
  isSessionIntegrityError,
} from "cursor-history";
import { MCP_ERROR_CODES, McpErrorCode, errorCodeName } from "./types.js";

/**
 * MCP-compatible error response
 */
export interface McpError {
  code: McpErrorCode;
  message: string;
  /** Optional one-line suggestion for how the caller can recover. */
  remedy?: string;
  data?: Record<string, unknown>;
}

/**
 * Error messages for each error code
 */
const ERROR_MESSAGES: Record<McpErrorCode, string> = {
  [MCP_ERROR_CODES.INTEGRITY_FAILED]: "History integrity check failed.",
  [MCP_ERROR_CODES.DATABASE_NOT_FOUND]:
    "Cursor data not found. Please ensure Cursor IDE is installed and has been used at least once.",
  [MCP_ERROR_CODES.DATABASE_LOCKED]:
    "Cursor database is locked. Please close Cursor IDE and try again, or retry read operations which may work.",
  [MCP_ERROR_CODES.SESSION_NOT_FOUND]:
    "Session not found. Please check the session index using cursor_history_list.",
  [MCP_ERROR_CODES.WORKSPACE_NOT_FOUND]:
    "Workspace not found. Please verify the workspace path exists.",
  [MCP_ERROR_CODES.BACKUP_FAILED]:
    "Backup operation failed. Check file permissions and available disk space.",
  [MCP_ERROR_CODES.RESTORE_FAILED]:
    "Restore operation failed. The backup file may be corrupted or inaccessible.",
  [MCP_ERROR_CODES.INVALID_BACKUP]:
    "Invalid or corrupted backup file. Please verify the backup file integrity.",
  [MCP_ERROR_CODES.INVALID_ARGUMENTS]: "Invalid arguments.",
  [MCP_ERROR_CODES.TIME_BUDGET_EXCEEDED]: "The operation exceeded its time budget.",
  [MCP_ERROR_CODES.CANCELLED]: "The operation was cancelled by the client.",
  [MCP_ERROR_CODES.SOURCE_LIMIT_EXCEEDED]: "A Cursor source exceeded the configured read limits.",
  [MCP_ERROR_CODES.WORKSPACE_AMBIGUOUS]: "The workspace value matches multiple workspaces.",
  [MCP_ERROR_CODES.SESSION_AMBIGUOUS]: "The session has multiple divergent copies.",
  [MCP_ERROR_CODES.SESSION_SCOPE_MISMATCH]: "The session is not part of the requested scope.",
  [MCP_ERROR_CODES.INTERNAL_ERROR]: "An unexpected error occurred.",
  [MCP_ERROR_CODES.PROTECTED_PATH]:
    "Refused: the output path is inside Cursor's data folders or is named like a Cursor database.",
  [MCP_ERROR_CODES.CURSOR_RUNNING]:
    "Refused: Cursor appears to be running (or its database is busy or has an unflushed -wal file).",
  [MCP_ERROR_CODES.LIVE_TARGET_NOT_CONFIRMED]:
    "Refused: this restore would overwrite the live Cursor data directory without confirmation.",
  [MCP_ERROR_CODES.SAFETY_COPY_FAILED]:
    "Refused: the verified safety copy could not be created, so nothing was changed.",
  [MCP_ERROR_CODES.INSUFFICIENT_DISK_SPACE]: "Refused: not enough free disk space for the safety copy.",
  [MCP_ERROR_CODES.SAFETY_COPY_REQUIRED]: "Refused: the safety copy cannot be skipped for the live Cursor data.",
  [MCP_ERROR_CODES.RESTORE_ROLLBACK_INCOMPLETE]:
    "Restore failed and the automatic rollback was incomplete. Some files may not be in their original state.",
};

/** Library integrity codes that get their own MCP code instead of INTEGRITY_FAILED. */
const INTEGRITY_CODE_MAP: Record<string, McpErrorCode> = {
  WORKSPACE_AMBIGUOUS: MCP_ERROR_CODES.WORKSPACE_AMBIGUOUS,
  SESSION_AMBIGUOUS: MCP_ERROR_CODES.SESSION_AMBIGUOUS,
  SESSION_SCOPE_MISMATCH: MCP_ERROR_CODES.SESSION_SCOPE_MISMATCH,
  SOURCE_LIMIT_EXCEEDED: MCP_ERROR_CODES.SOURCE_LIMIT_EXCEEDED,
  PROTECTED_PATH: MCP_ERROR_CODES.PROTECTED_PATH,
  CURSOR_RUNNING: MCP_ERROR_CODES.CURSOR_RUNNING,
  LIVE_TARGET_NOT_CONFIRMED: MCP_ERROR_CODES.LIVE_TARGET_NOT_CONFIRMED,
  RESTORE_SAFETY_COPY_FAILED: MCP_ERROR_CODES.SAFETY_COPY_FAILED,
  MIGRATION_SAFETY_COPY_FAILED: MCP_ERROR_CODES.SAFETY_COPY_FAILED,
  INSUFFICIENT_DISK_SPACE: MCP_ERROR_CODES.INSUFFICIENT_DISK_SPACE,
  SAFETY_COPY_REQUIRED: MCP_ERROR_CODES.SAFETY_COPY_REQUIRED,
  RESTORE_ROLLBACK_INCOMPLETE: MCP_ERROR_CODES.RESTORE_ROLLBACK_INCOMPLETE,
};

const INTEGRITY_REMEDIES: Partial<Record<McpErrorCode, string>> = {
  [MCP_ERROR_CODES.SOURCE_LIMIT_EXCEEDED]:
    "Narrow the request with `workspace`, or use cursor_history_export with chunkOffset for large sessions.",
  [MCP_ERROR_CODES.WORKSPACE_AMBIGUOUS]: "Pass a longer or exact `workspace` path.",
  [MCP_ERROR_CODES.SESSION_AMBIGUOUS]: "Resolve the divergent copies, or select a different session.",
  [MCP_ERROR_CODES.SESSION_SCOPE_MISMATCH]: "Use the same `workspace` that was used when listing the session.",
  [MCP_ERROR_CODES.PROTECTED_PATH]:
    "Choose an output path outside Cursor's folders (User, globalStorage, workspaceStorage, store) and do not name it like a database (.vscdb, .db, .sqlite, -wal, -shm).",
  [MCP_ERROR_CODES.CURSOR_RUNNING]:
    "Quit Cursor completely (check the system tray and background processes), then retry. Nothing was changed.",
  [MCP_ERROR_CODES.LIVE_TARGET_NOT_CONFIRMED]:
    "Quit Cursor, preview with dryRun=true, then repeat with dryRun=false, force=true and confirm=true.",
  [MCP_ERROR_CODES.SAFETY_COPY_FAILED]:
    "Nothing was changed. Check free disk space and permissions on the safety-copy location (CURSOR_HISTORY_RESTORE_SAFETY_DIR / CURSOR_HISTORY_SAFETY_DIR), then retry.",
  [MCP_ERROR_CODES.INSUFFICIENT_DISK_SPACE]:
    "Free disk space on the drive that holds the safety-copy folder, or point CURSOR_HISTORY_SAFETY_DIR at a drive with more room. Nothing was changed.",
  [MCP_ERROR_CODES.SAFETY_COPY_REQUIRED]:
    "Safety copies cannot be skipped for the default Cursor data location.",
  [MCP_ERROR_CODES.RESTORE_ROLLBACK_INCOMPLETE]:
    "Quit Cursor and copy the files listed in the safety copy's manifest.json back into the Cursor User directory by hand.",
};

const PROTECTED_REASONS: Record<string, string> = {
  "inside-cursor-data": "it is inside Cursor's data directory",
  "inside-cursor-global-storage": "it is inside Cursor's globalStorage directory",
  "inside-cursor-store": "it is inside Cursor's store directory",
  "database-file-name": "it is named like a database file",
};

/**
 * Error thrown by tool handlers; carries the typed envelope so the server can
 * render `[CODE] message` plus a remedy line.
 */
export class McpToolError extends Error {
  readonly mcp: McpError;
  constructor(mcp: McpError) {
    super(mcp.message);
    this.name = "McpToolError";
    this.mcp = mcp;
  }
}

/** Builds a typed error for a handler to throw. */
export function toToolError(error: unknown): Error {
  if (error instanceof McpToolError) return error;
  const mapped = mapCursorHistoryError(error);
  return new McpToolError(mapped);
}

/** Client-facing text: `[CODE] message` plus an optional remedy line. */
export function formatErrorText(error: McpError): string {
  const head = `[${errorCodeName(error.code)}] ${error.message}`;
  return error.remedy ? `${head}
${error.remedy}` : head;
}

function isZodLikeError(
  error: unknown
): error is { issues: { path: (string | number)[]; message: string }[] } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

/**
 * Maps a cursor-history error to an MCP error response
 */
export function mapCursorHistoryError(error: unknown): McpError {
  // Preserve actionable v0.18 failures before broad backup/restore guards
  // discard their scope, capability or publication recovery details.
  if (error instanceof McpToolError) return error.mcp;

  if (isSessionIntegrityError(error)) {
    const mappedCode = INTEGRITY_CODE_MAP[error.code];
    if (mappedCode !== undefined) {
      const details = (error.details ?? {}) as Record<string, unknown>;
      let message = error.message;
      let remedy =
        mappedCode === MCP_ERROR_CODES.LIVE_TARGET_NOT_CONFIRMED
          ? INTEGRITY_REMEDIES[mappedCode]
          : typeof details.remedy === "string" ? details.remedy : INTEGRITY_REMEDIES[mappedCode];
      if (mappedCode === MCP_ERROR_CODES.PROTECTED_PATH) {
        const why = typeof details.reason === "string" ? PROTECTED_REASONS[details.reason] : undefined;
        message = `${ERROR_MESSAGES[mappedCode]}${why ? ` Reason: ${why}.` : ""} The output must be outside Cursor's folders and must not be a database file.`;
      } else if (mappedCode === MCP_ERROR_CODES.LIVE_TARGET_NOT_CONFIRMED) {
        // The reader's text mentions CLI flags; MCP callers use `confirm`.
        message = "Refusing to overwrite the live Cursor data directory: force=true alone is not enough. Pass confirm=true as well.";
      } else if (mappedCode === MCP_ERROR_CODES.RESTORE_ROLLBACK_INCOMPLETE) {
        const dir = typeof details.safetyCopyDir === "string" ? details.safetyCopyDir : undefined;
        if (dir) remedy = `${remedy ?? ""}
Safety copy (verified originals + manifest.json): ${dir}`.trim();
      }
      return {
        code: mappedCode,
        message,
        remedy,
        data: { ...details },
      };
    }
    return {
      code: MCP_ERROR_CODES.INTEGRITY_FAILED,
      message: `${error.code}: ${error.message}\n${JSON.stringify(error.details)}`,
    };
  }

  if (isDatabaseNotFoundError(error)) {
    return {
      code: MCP_ERROR_CODES.DATABASE_NOT_FOUND,
      message: ERROR_MESSAGES[MCP_ERROR_CODES.DATABASE_NOT_FOUND],
    };
  }

  if (isDatabaseLockedError(error)) {
    return {
      code: MCP_ERROR_CODES.DATABASE_LOCKED,
      message: ERROR_MESSAGES[MCP_ERROR_CODES.DATABASE_LOCKED],
    };
  }

  if (isSessionNotFoundError(error)) {
    return {
      code: MCP_ERROR_CODES.SESSION_NOT_FOUND,
      message: ERROR_MESSAGES[MCP_ERROR_CODES.SESSION_NOT_FOUND],
    };
  }

  if (isWorkspaceNotFoundError(error)) {
    return {
      code: MCP_ERROR_CODES.WORKSPACE_NOT_FOUND,
      message: ERROR_MESSAGES[MCP_ERROR_CODES.WORKSPACE_NOT_FOUND],
    };
  }

  if (isBackupError(error)) {
    return {
      code: MCP_ERROR_CODES.BACKUP_FAILED,
      message: ERROR_MESSAGES[MCP_ERROR_CODES.BACKUP_FAILED],
    };
  }

  if (isRestoreError(error)) {
    return {
      code: MCP_ERROR_CODES.RESTORE_FAILED,
      message: ERROR_MESSAGES[MCP_ERROR_CODES.RESTORE_FAILED],
    };
  }

  if (isInvalidBackupError(error)) {
    return {
      code: MCP_ERROR_CODES.INVALID_BACKUP,
      message: ERROR_MESSAGES[MCP_ERROR_CODES.INVALID_BACKUP],
    };
  }

  // Argument validation failures: readable text instead of a raw JSON dump
  if (isZodLikeError(error)) {
    const text = error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
    return {
      code: MCP_ERROR_CODES.INVALID_ARGUMENTS,
      message: error.issues.length > 1 || error.issues[0]?.path.length ? `Invalid arguments: ${text}` : text,
      data: { validation: true },
    };
  }

  // Unknown error - wrap it
  const errorMessage =
    error instanceof Error ? error.message : "An unexpected error occurred";
  return {
    code: MCP_ERROR_CODES.INTERNAL_ERROR,
    message: errorMessage,
    data: {
      originalError: String(error),
    },
  };
}

/**
 * Wraps a tool handler function with error handling
 */
export async function withErrorHandling<T>(
  fn: () => Promise<T>
): Promise<T | McpError> {
  try {
    return await fn();
  } catch (error) {
    return mapCursorHistoryError(error);
  }
}

/**
 * Type guard to check if a result is an MCP error
 */
export function isMcpError(result: unknown): result is McpError {
  return (
    typeof result === "object" &&
    result !== null &&
    "code" in result &&
    "message" in result &&
    typeof (result as McpError).code === "number" &&
    typeof (result as McpError).message === "string"
  );
}
