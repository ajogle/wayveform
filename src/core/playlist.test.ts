import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeM3u8 } from './playlist';

describe('M3U8 export', () => {
  it('uses relative paths, preserves repeats, and counts unresolved songs', () => {
    const result = makeM3u8([
      { artist: 'A', title: 'One', durationMs: 92000, filePath: '/music/Album/one.flac' },
      { artist: 'A', title: 'One', durationMs: 92000, filePath: '/music/Album/one.flac' },
      { artist: 'B', title: 'Two', durationMs: null, filePath: null },
      { artist: 'C', title: 'Three', durationMs: null, filePath: null, unavailable: true },
    ], '/music/list.m3u8', path.posix);
    expect(result.included).toBe(2);
    expect(result.unresolved).toBe(1);
    expect(result.unavailable).toBe(1);
    expect(result.text.match(/Album\/one.flac/g)).toHaveLength(2);
    expect(result.text).toContain('#EXTINF:92,A - One');
  });

  it('does not emit absolute paths when files are on another Windows drive', () => {
    const result = makeM3u8([{ artist: 'A', title: 'One', durationMs: null,
      filePath: 'D:\\Music\\one.flac' }], 'C:\\Lists\\list.m3u8', path.win32);
    expect(result).toMatchObject({ included: 0, unavailable: 1 });
  });
});
