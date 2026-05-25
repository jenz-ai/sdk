/**
 * Contract test: verify our mappers handle the REAL upstream-SDK type shapes.
 *
 * 2B (openai-agents) shipped with mocked spans that passed unit tests but broke against
 * the real SDK — agent spans emit `tools: []` not `tools: ['x','y']`. Caught only by
 * E2E. This test prevents that class of bug for 2C by importing the actual types from
 * @anthropic-ai/claude-agent-sdk and constructing inputs that satisfy them.
 *
 * If upstream ever renames a field or changes a shape, this test fails at compile time
 * (TypeScript) — long before users hit it.
 */
import { describe, it, expect } from 'vitest';
import type {
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  SDKAssistantMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  mapAssistantMessage,
  mapPreToolUse,
  mapPostToolUse,
  mapPostToolUseFailure,
  mapSubagentStart,
  mapSubagentStop,
} from './event-mapping.js';

// BaseHookInput requires: session_id, transcript_path, cwd
// permission_mode is optional on the real type (permission_mode?: string)
// agent_id and agent_type are optional on BaseHookInput but required on SubagentStartHookInput / SubagentStopHookInput

describe('event-mapping contract against real @anthropic-ai/claude-agent-sdk types', () => {
  it('PreToolUseHookInput conforms', () => {
    const input: PreToolUseHookInput = {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp',
      tool_use_id: 'tu-1',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
    };
    const { start, toolUseId } = mapPreToolUse(input);
    expect(start.type).toBe('tool_call');
    expect(toolUseId).toBe('tu-1');
  });

  it('PostToolUseHookInput conforms', () => {
    const input: PostToolUseHookInput = {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp',
      tool_use_id: 'tu-1',
      tool_name: 'Read',
      tool_input: {},
      tool_response: 'response-string',
    };
    const { finish, toolUseId } = mapPostToolUse(input);
    expect(toolUseId).toBe('tu-1');
    expect(finish.output).toBe('response-string');
  });

  it('PostToolUseFailureHookInput conforms', () => {
    const input: PostToolUseFailureHookInput = {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'sess-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp',
      tool_use_id: 'tu-1',
      tool_name: 'Read',
      tool_input: {},
      error: 'file not found',
    };
    const { finish, toolUseId } = mapPostToolUseFailure(input);
    expect(toolUseId).toBe('tu-1');
    expect(finish.errorMessage).toContain('file not found');
  });

  it('SubagentStartHookInput conforms', () => {
    const input: SubagentStartHookInput = {
      hook_event_name: 'SubagentStart',
      session_id: 'sess-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp',
      agent_id: 'sub-1',
      agent_type: 'reviewer',
    };
    const { start, subagentId } = mapSubagentStart(input);
    expect(start.name).toBe('subagent:reviewer');
    expect(subagentId).toBe('sub-1');
  });

  it('SubagentStopHookInput conforms', () => {
    const input: SubagentStopHookInput = {
      hook_event_name: 'SubagentStop',
      session_id: 'sess-1',
      transcript_path: '/tmp/transcript.jsonl',
      cwd: '/tmp',
      stop_hook_active: false,
      agent_id: 'sub-1',
      agent_transcript_path: '/tmp/sub.jsonl',
      agent_type: 'reviewer',
    };
    const { finish, subagentId } = mapSubagentStop(input);
    expect(subagentId).toBe('sub-1');
    expect(finish.output).toBeUndefined();
  });

  it('SDKAssistantMessage with usage conforms', () => {
    const msg: SDKAssistantMessage = {
      type: 'assistant',
      message: {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
          service_tier: 'standard',
        },
      } as any,
      parent_tool_use_id: null,
      uuid: 'uuid-1',
      session_id: 'sess-1',
    };
    const { start, finish } = mapAssistantMessage(msg);
    expect(start.model).toBe('claude-sonnet-4-6');
    expect(finish.cacheReadTokens).toBe(10);
    expect(finish.cacheWriteTokens).toBe(5);
  });

  it('SDKAssistantMessage with text + tool_use content captures output text (JEN-60)', () => {
    const toolUse = { type: 'tool_use' as const, id: 'tu-1', name: 'Read', input: { file_path: '/a' } };
    const msg: SDKAssistantMessage = {
      type: 'assistant',
      message: {
        id: 'msg-2',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [
          { type: 'text', text: 'Let me look that up.' },
          toolUse,
        ],
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: {
          input_tokens: 200,
          output_tokens: 30,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          service_tier: 'standard',
        },
      } as any,
      parent_tool_use_id: null,
      uuid: 'uuid-2',
      session_id: 'sess-1',
    };
    const { finish } = mapAssistantMessage(msg);
    expect(finish.output).toContain('Let me look that up.');
    expect(finish.output).toContain('tool_use');
    expect(finish.output).toContain('Read');
  });
});
