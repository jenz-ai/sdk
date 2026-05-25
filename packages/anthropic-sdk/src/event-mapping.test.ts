import { describe, expect, it } from 'vitest';
import {
  clipError,
  extractToolResultBlocks,
  extractToolUseBlocks,
  extractUsage,
  llmInputSnapshot,
  llmOutputText,
  toolResultOutputString,
  toolUseInputString,
} from './event-mapping.js';

describe('llmInputSnapshot', () => {
  it('serialises messages as JSON', () => {
    const msg = [{ role: 'user', content: 'hello' }];
    expect(llmInputSnapshot(msg)).toBe('[{"role":"user","content":"hello"}]');
  });

  it('truncates to 8000 chars with an ellipsis', () => {
    const big = [{ role: 'user', content: 'x'.repeat(20000) }];
    const out = llmInputSnapshot(big);
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('llmOutputText', () => {
  it('joins text blocks with newlines', () => {
    const content = [
      { type: 'text', text: 'Hello.' },
      { type: 'text', text: 'World.' },
    ];
    expect(llmOutputText(content)).toBe('Hello.\nWorld.');
  });

  it('serialises tool_use blocks so the dashboard can detect them', () => {
    const content = [
      { type: 'text', text: 'I will search.' },
      { type: 'tool_use', id: 'tu_1', name: 'web_search', input: { q: 'seo' } },
    ];
    const out = llmOutputText(content);
    expect(out).toContain('I will search.');
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"name":"web_search"');
  });

  it('returns empty string for non-array content', () => {
    expect(llmOutputText(null)).toBe('');
    expect(llmOutputText('string')).toBe('');
    expect(llmOutputText(undefined)).toBe('');
  });
});

describe('extractUsage', () => {
  it('maps Anthropic usage fields to jenz token names', () => {
    expect(
      extractUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
    });
  });

  it('returns empty object when usage is undefined', () => {
    expect(extractUsage(undefined)).toEqual({});
  });
});

describe('extractToolUseBlocks', () => {
  it('returns only tool_use blocks with valid id+name', () => {
    const content = [
      { type: 'text', text: 'thinking' },
      { type: 'tool_use', id: 'tu_1', name: 'web_search', input: { q: 'seo' } },
      { type: 'tool_use', id: 'tu_2', name: 'read_file', input: { path: '/a' } },
      { type: 'tool_use', name: 'missing_id' }, // skipped
    ];
    const blocks = extractToolUseBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.id).toBe('tu_1');
    expect(blocks[1]!.name).toBe('read_file');
  });

  it('returns [] for non-array content', () => {
    expect(extractToolUseBlocks(null)).toEqual([]);
    expect(extractToolUseBlocks('text')).toEqual([]);
  });
});

describe('extractToolResultBlocks', () => {
  it('returns tool_result blocks with their is_error flag', () => {
    const content = [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'fail', is_error: true },
    ];
    const blocks = extractToolResultBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.is_error).toBe(false);
    expect(blocks[1]!.is_error).toBe(true);
  });

  it('skips blocks without tool_use_id', () => {
    const content = [{ type: 'tool_result' }, { type: 'text', text: 'x' }];
    expect(extractToolResultBlocks(content)).toEqual([]);
  });
});

describe('toolUseInputString', () => {
  it('stringifies object input', () => {
    expect(toolUseInputString({ query: 'seo 2026' })).toBe('{"query":"seo 2026"}');
  });

  it('defaults null/undefined to "{}" (tool calls always have an input object)', () => {
    expect(toolUseInputString(null)).toBe('{}');
    expect(toolUseInputString(undefined)).toBe('{}');
  });

  it('truncates to 4096 chars', () => {
    const big = { x: 'x'.repeat(10000) };
    expect(toolUseInputString(big).length).toBeLessThanOrEqual(4096);
  });
});

describe('toolResultOutputString', () => {
  it('passes strings through verbatim', () => {
    expect(toolResultOutputString('hello world')).toBe('hello world');
  });

  it('stringifies non-string content', () => {
    expect(toolResultOutputString([{ type: 'text', text: 'a' }])).toBe(
      '[{"type":"text","text":"a"}]',
    );
  });
});

describe('clipError', () => {
  it('extracts Error.message', () => {
    expect(clipError(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(clipError({ code: 'E_FAIL' })).toBe('{"code":"E_FAIL"}');
  });

  it('truncates long messages', () => {
    expect(clipError(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(1000);
  });
});
