import fs from "fs";
import path from "path";
import { execFile, exec } from "child_process";
import util from "util";
import { logger } from "../utils/logger";

const execFileAsync = util.promisify(execFile);
const execAsync = util.promisify(exec);

const DEFAULT_WORKSPACE_ROOT = process.env.WORKSPACE_ROOT || process.cwd();

function resolvePath(p: string, root: string): string {
  return path.resolve(root, p);
}

function isPathSafe(p: string, root: string): boolean {
  const resolved = resolvePath(p, root);
  return resolved.startsWith(root) || resolved.startsWith("/tmp/") || resolved === "/tmp";
}

export const NATIVE_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Returns line-numbered content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to workspace root)" },
          startLine: { type: "number", description: "Start line (1-based, optional)" },
          endLine: { type: "number", description: "End line (1-based, optional)" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a new file or overwrite an existing file with the given content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to workspace root)" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace a specific string in a file with new content. The old_string must be an exact, unique match in the file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (relative to workspace root)" },
          old_string: { type: "string", description: "Exact string to find and replace (must be unique in the file)" },
          new_string: { type: "string", description: "Replacement string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_command",
      description: "Execute a shell command in the workspace directory. Use for running builds, tests, git, npm, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          timeout: { type: "number", description: "Timeout in ms (default 30000, max 120000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for a pattern in files using grep. Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The string or regex pattern to search for" },
          directory: { type: "string", description: "Directory to search in (default: workspace root)" },
          include: { type: "string", description: "File glob pattern to include (e.g. '*.ts')" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List contents of a directory with file types indicated.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path (relative to workspace root)" },
        },
        required: ["path"],
      },
    },
  },
];

const BLOCKED_COMMANDS = [
  /\brm\s+-rf\s+\/(?!\S)/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bsudo\b/,
];

function isCommandSafe(cmd: string): boolean {
  return !BLOCKED_COMMANDS.some((re) => re.test(cmd));
}

export async function executeNativeTool(name: string, args: Record<string, unknown>, workspaceRoot?: string): Promise<string> {
  const root = workspaceRoot || DEFAULT_WORKSPACE_ROOT;
  try {
    switch (name) {
      case "read_file": {
        const filePath = resolvePath(args.path as string, root);
        if (!isPathSafe(args.path as string, root)) return "Error: Path is outside workspace";
        if (!fs.existsSync(filePath)) return `Error: File not found: ${args.path}`;

        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) return `Error: ${args.path} is a directory. Use list_directory.`;

        const raw = fs.readFileSync(filePath, "utf-8");
        const lines = raw.split("\n");
        const start = Math.max(1, (args.startLine as number) || 1);
        const end = Math.min(lines.length, (args.endLine as number) || lines.length);
        const selected = lines.slice(start - 1, end);

        const numbered = selected.map((line, i) => `${String(start + i).padStart(5)}| ${line}`).join("\n");
        const header = `File: ${args.path} (${lines.length} lines total, showing ${start}-${end})\n`;

        if (numbered.length > 100000) {
          return header + numbered.slice(0, 100000) + "\n...[truncated]";
        }
        return header + numbered;
      }

      case "write_file": {
        const filePath = resolvePath(args.path as string, root);
        if (!isPathSafe(args.path as string, root)) return "Error: Path is outside workspace";

        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(filePath, args.content as string, "utf-8");
        const lineCount = (args.content as string).split("\n").length;
        return `Successfully wrote ${lineCount} lines to ${args.path}`;
      }

      case "edit_file": {
        const filePath = resolvePath(args.path as string, root);
        if (!isPathSafe(args.path as string, root)) return "Error: Path is outside workspace";
        if (!fs.existsSync(filePath)) return `Error: File not found: ${args.path}`;

        const content = fs.readFileSync(filePath, "utf-8");
        const oldStr = args.old_string as string;
        const newStr = args.new_string as string;

        if (oldStr === newStr) return "Error: old_string and new_string are identical";

        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) return `Error: old_string not found in ${args.path}. Make sure it matches exactly (including whitespace and indentation).`;
        if (occurrences > 1) return `Error: old_string found ${occurrences} times in ${args.path}. It must be unique. Include more surrounding context.`;

        const updated = content.replace(oldStr, newStr);
        fs.writeFileSync(filePath, updated, "utf-8");

        const oldLines = oldStr.split("\n").length;
        const newLines = newStr.split("\n").length;
        return `Successfully edited ${args.path}: replaced ${oldLines} lines with ${newLines} lines`;
      }

      case "execute_command": {
        const cmd = args.command as string;
        if (!cmd) return "Error: command is required";
        if (!isCommandSafe(cmd)) return "Error: Command blocked for safety reasons";

        const timeoutMs = Math.min((args.timeout as number) || 30000, 120000);

        try {
          const { stdout, stderr } = await execAsync(cmd, {
            cwd: root,
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024 * 5,
            env: { ...process.env, FORCE_COLOR: "0" },
          });

          let output = "";
          if (stdout) output += stdout;
          if (stderr) output += (output ? "\n[stderr]\n" : "[stderr]\n") + stderr;
          if (!output) output = "(no output)";

          if (output.length > 50000) {
            output = output.slice(0, 50000) + "\n...[truncated]";
          }
          return output;
        } catch (err: unknown) {
          const e = err as { code?: number; signal?: string; stdout?: string; stderr?: string; message?: string; killed?: boolean };
          if (e.killed) return `Error: Command timed out after ${timeoutMs}ms`;
          let output = `Command failed (exit code: ${e.code || "unknown"})`;
          if (e.stdout) output += "\n[stdout]\n" + e.stdout.slice(0, 20000);
          if (e.stderr) output += "\n[stderr]\n" + e.stderr.slice(0, 20000);
          return output;
        }
      }

      case "search_files": {
        if (!args.query) return "Error: query is required";
        const dir = args.directory ? resolvePath(args.directory as string, root) : root;
        if (!isPathSafe(args.directory as string || ".", root)) return "Error: Path is outside workspace";

        const grepArgs = ["-RnI", "--color=never"];
        if (args.include) grepArgs.push(`--include=${args.include}`);
        grepArgs.push(args.query as string, dir);

        try {
          const { stdout } = await execFileAsync("grep", grepArgs, { timeout: 15000 });
          const lines = stdout.split("\n").filter(Boolean);
          if (lines.length === 0) return "No matches found.";
          if (lines.length > 100) {
            return lines.slice(0, 100).join("\n") + `\n...[${lines.length - 100} more matches. Be more specific.]`;
          }
          return stdout;
        } catch (err: unknown) {
          const e = err as { code?: number; message?: string };
          if (e.code === 1) return "No matches found.";
          return `Error: ${e.message}`;
        }
      }

      case "list_directory": {
        const dirPath = resolvePath(args.path as string, root);
        if (!isPathSafe(args.path as string, root)) return "Error: Path is outside workspace";
        if (!fs.existsSync(dirPath)) return `Error: Directory not found: ${args.path}`;

        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) return `Error: ${args.path} is not a directory. Use read_file.`;

        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const formatted = entries.map((e) => {
          const suffix = e.isDirectory() ? "/" : "";
          return `${suffix ? "📁" : "📄"} ${e.name}${suffix}`;
        });
        return `Directory: ${args.path} (${entries.length} items)\n${formatted.join("\n")}`;
      }

      default:
        return `Error: Tool "${name}" not found. Available: read_file, write_file, edit_file, execute_command, search_files, list_directory`;
    }
  } catch (err: unknown) {
    const e = err as Error;
    logger.error(`[Tools] Error executing ${name}:`, e);
    return `Error: ${e.message}`;
  }
}
