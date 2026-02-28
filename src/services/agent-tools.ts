import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import util from "util";
import { logger } from "../utils/logger";

const execFileAsync = util.promisify(execFile);

export const NATIVE_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a local file in the workspace",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file",
          },
        },
        required: ["path"],
      },
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for files by name or grep inside files for a pattern",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The string or pattern to search for",
          },
          directory: {
            type: "string",
            description: "The directory to search in (default is current directory)",
            default: ".",
          },
        },
        required: ["query"],
      },
    }
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the contents of a directory",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the directory",
          },
        },
        required: ["path"],
      },
    }
  }
];

export async function executeNativeTool(name: string, args: Record<string, any>): Promise<string> {
  const cwd = process.cwd();
  try {
    switch (name) {
      case "read_file": {
        if (!args.path) return "Error: path is required";
        const filePath = path.resolve(cwd, args.path);
        if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
        
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) return `Error: ${filePath} is a directory. Use list_directory.`;
        
        const content = fs.readFileSync(filePath, "utf-8");
        return content.length > 50000 
          ? content.slice(0, 50000) + "\n...[truncated due to size]" 
          : content;
      }
      
      case "search_files": {
        if (!args.query) return "Error: query is required";
        const dir = args.directory ? path.resolve(cwd, args.directory) : cwd;
        
        try {
          // Use grep efficiently. -R recursive, -n line numbers, -i ignore case, -I ignore binary
          const { stdout } = await execFileAsync("grep", ["-RnI", args.query, dir], { timeout: 10000 });
          const lines = stdout.split("\n").filter(Boolean);
          if (lines.length === 0) return "No matches found.";
          
          if (lines.length > 50) {
            return lines.slice(0, 50).join("\n") + `\n...[${lines.length - 50} more matches omitted. Be more specific.]`;
          }
          return stdout;
        } catch (err: any) {
          // grep exits with code 1 if no lines are found
          if (err.code === 1) return "No matches found.";
          return `Error running search: ${err.message}`;
        }
      }
      
      case "list_directory": {
        if (!args.path) return "Error: path is required";
        const dirPath = path.resolve(cwd, args.path);
        if (!fs.existsSync(dirPath)) return `Error: Directory not found: ${dirPath}`;
        
        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) return `Error: ${dirPath} is not a directory. Use read_file.`;
        
        const files = fs.readdirSync(dirPath);
        return files.join("\n");
      }
      
      default:
        return `Error: Tool ${name} not found`;
    }
  } catch (err: any) {
    logger.error(`[Tools] Error executing ${name}:`, err);
    return `Error executing tool: ${err.message}`;
  }
}
