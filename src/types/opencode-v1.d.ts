/**
 * Vendor'd OpenCode V1 type declarations.
 * Minimal types to support compilation when @opencode-ai/plugin is not installed.
 */

declare module "@opencode-ai/plugin" {
  import type { createOpencodeClient, Part, Message } from "@opencode-ai/sdk";

  export type PluginInput = {
    client: ReturnType<typeof createOpencodeClient>;
    project: any;
    directory: string;
    [key: string]: any;
  };

  export type PluginOptions = Record<string, unknown>;

  export type Hooks = {
    event?: (events: any) => Promise<void>;
    dispose?: () => Promise<void> | void;
    [key: string]: any;
  };

  export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>;
}

declare module "@opencode-ai/sdk" {
  export interface Part {
    id?: string;
    sessionID?: string;
    messageID?: string;
    type: string;
    [key: string]: any;
  }

  export interface TextPartInput extends Part {
    type: "text";
    text: string;
  }

  export interface FilePartInput extends Part {
    type: "file";
    url: string;
    [key: string]: any;
  }

  export interface AgentPartInput extends Part {
    type: "agent";
    id: string;
  }

  export interface SubtaskPartInput extends Part {
    type: "subtask";
    id: string;
  }

  export interface RetryPart extends Part {
    type: "retry";
    [key: string]: any;
  }

  export interface SessionStatus {
    sessionID?: string;
    status?: string;
    action?: string;
    message?: string;
    next?: number;
    [key: string]: any;
  }

  export interface Message {
    info?: {
      agent?: {
        id: string;
        provider?: string;
        model?: {
          providerID: string;
          modelID: string;
        };
      };
      [key: string]: any;
    };
    parts?: Part[];
    [key: string]: any;
  }

  export function createOpencodeClient(...args: any[]): any;
}
