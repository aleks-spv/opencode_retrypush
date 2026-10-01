/**
 * Vendor'd OpenCode V2 type declarations.
 * Used as fallback when @opencode/plugin cannot be installed via npm.
 * Copied from @opencode/plugin@2.0.21 and @opencode/client@2.0.21.
 */

declare module "@opencode/plugin" {
  export interface Context {
    readonly options: PluginOptions;
    readonly session: SessionDomain;
    readonly command: CommandDomain;
  }

  export type PluginOptions = Readonly<Record<string, any>>;

  export type Cleanup = () => Promise<void> | void;

  export interface Plugin {
    readonly id: string;
    readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void;
  }

  export function define(plugin: Plugin): Plugin;

  // Session-related types
  export namespace Session {
    type ID = string;
  }

  export namespace PromptInput {
    interface Prompt {
      parts?: any[];
      [key: string]: any;
    }
  }

  export namespace SessionInbox {
    type Delivery = any;
  }

  export namespace SessionError {
    interface Error {
      message?: string;
      [key: string]: any;
    }
  }

  export namespace Agent {
    type ID = string | { id: string };
  }

  export namespace Model {
    interface Ref {
      providerID?: string;
      modelID?: string;
      [key: string]: any;
    }
  }

  export interface SessionRetryDecision {
    retry: false;
  } | {
    retry: true;
    delay: number;
  }

  export interface SessionRetry {
    readonly sessionID: string;
    readonly agent: Agent.ID;
    readonly model: Model.Ref;
    readonly error: SessionError.Error;
    readonly attempt: number;
    decision: SessionRetryDecision;
  }

  export interface CommandInvocation {
    readonly sessionID: string;
    readonly prompt: PromptInput.Prompt;
    readonly delivery: SessionInbox.Delivery;
  }

  export interface CommandDefinition {
    readonly name: string;
    readonly description?: string;
    readonly execute: (input: CommandInvocation) => Promise<void>;
  }

  export interface CommandEditor {
    add(definition: CommandDefinition): void;
  }

  export interface Registration {
    readonly dispose: () => Promise<void>;
  }

  export type Hooks<Spec> = <Name extends keyof Spec>(
    name: Name,
    callback: (input: Spec[Name]) => Promise<void> | void
  ) => Promise<Registration>;

  export type ModelHooks<Spec> = <Name extends keyof Spec>(
    name: Name,
    callback: (input: Spec[Name]) => Promise<void> | void,
    options?: any
  ) => Promise<Registration>;

  export interface SessionHooks {
    readonly retry: SessionRetry;
    [key: string]: any;
  }

  export interface SessionDomain {
    readonly hook: ModelHooks<SessionHooks>;
    prompt(input: any): Promise<any>;
    [key: string]: any;
  }

  export interface CommandDomain {
    readonly transform: (callback: (input: CommandEditor) => void) => Promise<Registration>;
    reload(): Promise<void>;
  }
}
