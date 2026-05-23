import { describe, it, expect } from 'vitest';
import * as pkg from './index.js';

describe('public exports', () => {
  it('exports query, getActiveRun, SDK_VERSION — and nothing else', () => {
    expect(Object.keys(pkg).sort()).toEqual(['SDK_VERSION', 'getActiveRun', 'query']);
  });

  it('SDK_VERSION is a non-empty string', () => {
    expect(typeof pkg.SDK_VERSION).toBe('string');
    expect(pkg.SDK_VERSION.length).toBeGreaterThan(0);
  });

  it('query is a function', () => {
    expect(typeof pkg.query).toBe('function');
  });

  it('getActiveRun is a function', () => {
    expect(typeof pkg.getActiveRun).toBe('function');
  });
});
