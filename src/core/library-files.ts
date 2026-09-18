export function safeMusicSegment(value: string | null | undefined, fallback: string): string {
  let segment = (value ?? '').normalize('NFKC')
    .replace(/[<>:"/\\|?*\x00-\x1F\x7F]/g, '_')
    .replace(/\s+/g, ' ').replace(/[. ]+$/g, '').trim();
  if (!segment || segment === '.' || segment === '..') segment = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) segment = `_${segment}`;
  return [...segment].slice(0, 100).join('');
}
