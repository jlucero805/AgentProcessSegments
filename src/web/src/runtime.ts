import {
  useExternalStoreRuntime,
  type AssistantRuntime,
  type ThreadMessageLike,
} from '@assistant-ui/react';
import { textOfParts, type ChatMessage } from './chat';

export interface ChatRuntimeOptions {
  messages: ChatMessage[];
  running: boolean;
  disabled?: boolean;
  onNew: (text: string) => Promise<void>;
}

/**
 * assistant-ui external store runtime: React owns the messages and the running
 * flag, and the UI is a pure projection of that state.
 */
export function useChatRuntime({
  messages,
  running,
  disabled,
  onNew,
}: ChatRuntimeOptions): AssistantRuntime {
  return useExternalStoreRuntime<ChatMessage>({
    messages,
    isRunning: running,
    isDisabled: disabled,
    convertMessage: (message): ThreadMessageLike => ({
      id: message.id,
      role: message.role,
      createdAt: message.createdAt,
      content: message.parts.map((part) =>
        part.type === 'text'
          ? { type: 'text' as const, text: part.text }
          : {
              type: 'tool-call' as const,
              toolCallId: part.id,
              toolName: part.name,
              argsText: part.input,
              result: part.result,
              isError: part.error,
            },
      ),
    }),
    async onNew(message) {
      const text = textOfParts(message.content);
      if (text.trim()) await onNew(text);
    },
  });
}
