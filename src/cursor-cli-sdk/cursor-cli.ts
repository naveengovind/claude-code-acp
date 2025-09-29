import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

/**
 * Type definitions for Cursor CLI output format
 * Based on https://cursor.com/docs/cli/reference/output-format
 */

// Base message interface - all messages include session_id
export interface BaseMessage {
  session_id: string;
}

// Content types for messages
export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export type MessageContent = TextContent | ImageContent;

// Message role and structure
export interface Message {
  role: "user" | "assistant" | "system";
  content: MessageContent[];
}

// System initialization message
export interface SystemMessage extends BaseMessage {
  type: "system";
  subtype: "init";
  apiKeySource: "login" | "env" | "config";
  cwd: string;
  model: string;
  permissionMode: "default" | "strict" | "permissive";
}

// User input message
export interface UserMessage extends BaseMessage {
  type: "user";
  message: Message & { role: "user" };
}

// Assistant response message (streamed in chunks)
export interface AssistantMessage extends BaseMessage {
  type: "assistant";
  message: Message & { role: "assistant" };
}

// Final result message with metadata
export interface ResultMessage extends BaseMessage {
  type: "result";
  subtype: "success" | "error";
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  result: string;
  request_id: string;
}

// Error message for failed operations
export interface ErrorMessage extends BaseMessage {
  type: "error";
  error: {
    message: string;
    code?: string;
    details?: any;
  };
}

// Progress message for long-running operations
export interface ProgressMessage extends BaseMessage {
  type: "progress";
  progress: {
    current: number;
    total: number;
    message?: string;
  };
}

// Raw message for unparseable lines
export interface RawMessage {
  type: "raw";
  data: string;
}

// Union type for all possible cursor agent messages
export type CursorAgentMessage = 
  | SystemMessage 
  | UserMessage 
  | AssistantMessage 
  | ResultMessage 
  | ErrorMessage 
  | ProgressMessage 
  | RawMessage;

// Type guard utility functions for better type safety
export function isSystemMessage(message: CursorAgentMessage): message is SystemMessage {
  return message.type === 'system';
}

export function isUserMessage(message: CursorAgentMessage): message is UserMessage {
  return message.type === 'user';
}

export function isAssistantMessage(message: CursorAgentMessage): message is AssistantMessage {
  return message.type === 'assistant';
}

export function isResultMessage(message: CursorAgentMessage): message is ResultMessage {
  return message.type === 'result';
}

export function isErrorMessage(message: CursorAgentMessage): message is ErrorMessage {
  return message.type === 'error';
}

export function isProgressMessage(message: CursorAgentMessage): message is ProgressMessage {
  return message.type === 'progress';
}

export function isRawMessage(message: CursorAgentMessage): message is RawMessage {
  return message.type === 'raw';
}

const execFileAsync = promisify(execFile);

export class ChatSession {
  private chatId: string | undefined;
  private currentProcess: ReturnType<typeof spawn> | null = null;
  private cancelled = false;
  private workingDirectory?: string;
  
  constructor(cwd?: string) {
    this.workingDirectory = cwd;
  }
  public async createChat(): Promise<ChatSession> {
    try {
      const { stdout } = await execFileAsync('cursor-agent', ['create-chat']);
      this.chatId = stdout.trim();
      return this;
    } catch (error) {
      throw new Error(`Failed to create session: ${error}`);
    }
  }
  public getChatId(): string {
    if (!this.chatId) {
      throw new Error("Session ID not available");
    }
    return this.chatId;
  }

  /**
   * Cancel the current chat session and terminate any running process
   */
  public async cancel(): Promise<void> {
    this.cancelled = true;
    
    if (this.currentProcess && !this.currentProcess.killed) {
      console.log("Cancelling cursor-agent process...");
      this.currentProcess.kill("SIGTERM");
      
      // Force kill after 2 seconds if it doesn't terminate gracefully
      setTimeout(() => {
        if (this.currentProcess && !this.currentProcess.killed) {
          console.log("Force killing cursor-agent process...");
          this.currentProcess.kill("SIGKILL");
        }
      }, 2000);
    }
  }

  /**
   * Check if the session is cancelled
   */
  public isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Reset the cancelled state (useful for reusing sessions)
   */
  public resetCancelledState(): void {
    this.cancelled = false;
  }

  /**
   * Get the working directory for this session
   */
  public getWorkingDirectory(): string | undefined {
    return this.workingDirectory;
  }

  /**
   * Set the working directory for this session
   */
  public setWorkingDirectory(cwd: string): void {
    this.workingDirectory = cwd;
  }

  /**
   * Check if a process is currently running
   */
  public isProcessRunning(): boolean {
    return this.currentProcess !== null && !this.currentProcess.killed;
  }

  /**
   * Get the current process PID (if running)
   */
  public getProcessId(): number | undefined {
    return this.currentProcess?.pid;
  }

  /**
   * Cleanup resources (call when done with session)
   */
  public async cleanup(): Promise<void> {
    await this.cancel();
    this.currentProcess = null;
    this.chatId = undefined;
  }

  public async* sendMessage(message: string, options?: {
    model?: string;
    force?: boolean;
  }): AsyncGenerator<CursorAgentMessage, void, unknown> {
    if (!this.chatId) {
      throw new Error("Session ID not available. Call createChat() first.");
    }

    // Use the same args pattern as acp-agent.ts
    const args = [
      "-p", // Print mode (headless)
      "--output-format", "stream-json", // JSON streaming output for proper parsing
    ];
    
    // Add force flag if specified (default true for compatibility)
    if (options?.force !== false) {
      args.push("--force"); // Allow file modifications without prompts
    }
    
    // Add message
    args.push(message);
    
    // Resume with existing session
    args.push("--resume", this.chatId);
    
    // Add model selection if specified
    if (options?.model) {
      args.push("--model", options.model);
    }
    
    // Check if session was already cancelled
    if (this.cancelled) {
      return;
    }

    console.log('Spawning cursor-agent with args:', args);
    
    const childProcess = spawn("cursor-agent", args, {
      cwd: this.workingDirectory || process.cwd(), // Use session working directory if set
      stdio: ["ignore", "pipe", "pipe"], // ignore stdin to prevent hanging
      env: {
        ...process.env,
        CURSOR_API_KEY: process.env.CURSOR_API_KEY,
      }
    });

    // Track the current process for cancellation
    this.currentProcess = childProcess;

    let output = "";
    let errorOutput = "";
    let hasOutput = false;
    let isCompleted = false;

    // Set a timeout to prevent infinite hanging - cursor-agent usually responds in 4-10s
    const timeout = setTimeout(() => {
      console.error("Cursor agent process timeout, killing...");
      childProcess.kill("SIGTERM");
      setTimeout(() => childProcess.kill("SIGKILL"), 1000); // Force kill after 1s
      if (!isCompleted) {
        throw new Error("Cursor agent process timeout");
      }
    }, 60000); // 60 second timeout

    try {
      // Handle stdout data streaming
      if (childProcess.stdout) {
        childProcess.stdout.on("data", (data: Buffer) => {
          const text = data.toString();
          output += text;
          hasOutput = true;
          
          // Parse JSON streaming output from cursor-agent
          const lines = text.split('\n').filter((line: string) => line.trim());
          
          for (const line of lines) {
            if (line.trim()) {
              try {
                const jsonData = JSON.parse(line);
                // We can't yield from event handlers, so we store and process later
              } catch (parseError) {
                // If it's not valid JSON, we'll handle it as raw data
              }
            }
          }
        });
      }

      // Handle stderr
      if (childProcess.stderr) {
        childProcess.stderr.on("data", (data: Buffer) => {
          const errorText = data.toString();
          errorOutput += errorText;
          console.error("Cursor agent stderr:", errorText);
        });
      }

      // Use readline interface for proper async iteration
      const rl = createInterface({
        input: childProcess.stdout!,
        crlfDelay: Infinity
      });

      // Process each line as it comes
      for await (const line of rl) {
        // Check for cancellation before processing each line
        if (this.cancelled) {
          console.log("Chat session was cancelled, stopping message processing");
          break;
        }
        
        if (line.trim()) {
          try {
            const jsonData = JSON.parse(line);
            
            // Handle different types of streaming JSON responses from cursor-agent
            if (jsonData.type === "result" && jsonData.subtype === "success") {
              // Handle final result - this indicates completion
              isCompleted = true;
              clearTimeout(timeout);
              this.currentProcess = null; // Clear process reference
              yield jsonData;
              break;
            } else if (jsonData.type === "result" && jsonData.subtype !== "success") {
              // Handle errors
              isCompleted = true;
              clearTimeout(timeout);
              this.currentProcess = null; // Clear process reference
              yield jsonData;
              throw new Error(`Cursor agent failed: ${jsonData.subtype}`);
            } else {
              // Yield all other message types (system, user, assistant, etc.)
              yield jsonData;
            }
            
          } catch (parseError) {
            // If it's not valid JSON, treat as raw text
            if (line.trim()) {
              yield { type: 'raw', data: line } as RawMessage;
            }
          }
        }
      }

    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }

    // Handle process completion
    const exitPromise = new Promise<number | null>((resolve, reject) => {
      childProcess.on("error", (error: Error) => {
        clearTimeout(timeout);
        console.error("Cursor agent process error:", error);
        reject(error);
      });

      childProcess.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timeout);
        this.currentProcess = null; // Clear process reference on exit
        
        if (this.cancelled || signal === "SIGTERM" || signal === "SIGKILL") {
          console.log("Cursor agent process was terminated");
          resolve(code);
          return;
        }
        
        if (code === 0 || isCompleted) {
          resolve(code);
        } else {
          console.error("Cursor agent exited with code:", code, "signal:", signal, "Error:", errorOutput);
          reject(new Error(`Cursor agent failed with code ${code}: ${errorOutput}`));
        }
      });
    });

    if (!isCompleted) {
      await exitPromise;
    }
  }
}

export class CursorCli {
  private static instance: CursorCli;

  private constructor() {}

  public static getInstance(): CursorCli {
    if (!CursorCli.instance) {
      CursorCli.instance = new CursorCli();
    }
    return CursorCli.instance;
  }

  public async createNewChat(): Promise<ChatSession> {
    return await new ChatSession().createChat();
  }

  /**
   * Create a new chat session with custom working directory
   */
  public async createNewChatInDirectory(cwd: string): Promise<ChatSession> {
    const session = new ChatSession(cwd);
    return await session.createChat();
  }

  /**
   * Get cursor-agent version
   */
  public async getVersion(): Promise<string> {
    try {
      const { stdout } = await execFileAsync("cursor-agent", ["--version"], {
        timeout: 3000,
      });
      return stdout.trim();
    } catch (error: any) {
      throw new Error(`Failed to get cursor-agent version: ${error.message}`);
    }
  }

  /**
   * Check cursor-agent installation and authentication status
   */
  public async checkStatus(): Promise<{
    installed: boolean;
    authenticated: boolean;
    output: string;
    error?: string;
  }> {
    try {
      const { stdout, stderr } = await execFileAsync("cursor-agent", ["status"], {
        env: {
          ...process.env,
          CURSOR_API_KEY: process.env.CURSOR_API_KEY,
        },
        timeout: 10000, // 10 second timeout
      });

      const output = stdout.trim();
      const authenticated = output.includes("Logged in") || output.includes("authenticated");
      
      return {
        installed: true,
        authenticated,
        output,
        error: stderr?.trim() || undefined,
      };
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        return {
          installed: false,
          authenticated: false,
          output: "",
          error: "Cursor CLI not found. Install with: curl https://cursor.com/install -fsS | bash",
        };
      } else if (error.code === 'TIMEOUT') {
        return {
          installed: true,
          authenticated: false,
          output: "",
          error: "Cursor CLI authentication check timeout",
        };
      } else {
        return {
          installed: true,
          authenticated: false,
          output: error.stdout || "",
          error: error.stderr || error.message || "Cursor CLI not working properly or not authenticated",
        };
      }
    }
  }

  /**
   * Get available commands from cursor-agent help
   */
  public async getAvailableCommands(): Promise<{
    commands: Array<{
      name: string;
      description: string;
      input?: any;
    }>;
    helpText: string;
  }> {
    try {
      const { stdout } = await execFileAsync("cursor-agent", ["--help"], {
        env: {
          ...process.env,
          CURSOR_API_KEY: process.env.CURSOR_API_KEY,
        },
        timeout: 5000, // 5 second timeout for help
      });

      // Parse help output to extract commands
      const helpText = stdout.trim();
      const commands = [
        {
          name: "help",
          description: "Show help information",
          input: null,
        },
        {
          name: "model",
          description: "Change the AI model",
          input: { hint: "model name (e.g., sonnet-4, gpt-4, claude-3)" },
        },
        {
          name: "status",
          description: "Check authentication and connection status",
          input: null,
        },
      ];

      return {
        commands,
        helpText,
      };
    } catch (error: any) {
      // Return basic commands if help fails
      return {
        commands: [
          {
            name: "help",
            description: "Show help information",
            input: null,
          },
          {
            name: "model",
            description: "Change the AI model",
            input: { hint: "model name (e.g., sonnet-4, gpt-4, claude-3)" },
          },
        ],
        helpText: "Help not available",
      };
    }
  }
}
