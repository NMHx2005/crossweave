import { describe, it, expect } from 'bun:test';
import { extractWorkspaceId } from '../../src/gateway/relay-worker.js';

describe('relay-worker workspace routing', () => {
  it('extracts workspaceId from query', () => {
    expect(extractWorkspaceId('http://x/ws?workspaceId=ws1')).toBe('ws1');
    expect(extractWorkspaceId('http://x/ws?workspace_id=ws2')).toBe('ws2');
  });
  it('extracts from header', () => {
    expect(extractWorkspaceId('http://x/ws', { 'x-workspace-id': 'ws3' })).toBe('ws3');
  });
  it('returns undefined when absent', () => {
    expect(extractWorkspaceId('http://x/ws')).toBeUndefined();
  });
});
