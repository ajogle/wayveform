import { describe, expect, it } from 'vitest';
import { safeMusicSegment } from './library-files';

describe('library path segments', () => {
  it('removes separators, traversal names, and Windows reserved names', () => {
    expect(safeMusicSegment('../Live: Album?', 'Unknown')).toBe('.._Live_ Album_');
    expect(safeMusicSegment('..', 'Unknown')).toBe('Unknown');
    expect(safeMusicSegment('CON', 'Unknown')).toBe('_CON');
    expect(safeMusicSegment('CON.live', 'Unknown')).toBe('_CON.live');
  });

  it('keeps readable Unicode names', () => {
    expect(safeMusicSegment('Björk — Jóga', 'Unknown')).toBe('Björk — Jóga');
  });
});
