/**
 * YouTube search without an account or API key: parse the public results page.
 * Best effort — YouTube changes its markup; on any failure we return [] and the
 * UI falls back to opening the search page on the TV instead of playing straight.
 *
 * Thumbnails use the stable i.ytimg.com pattern so we never depend on the page for them.
 */
import { fetchText } from './icons';

export interface VideoResult {
  id: string;
  title: string;
  channel?: string;
  duration?: string;
  thumbnail: string;
  url: string;
}

export async function searchYouTube(query: string, limit = 8): Promise<VideoResult[]> {
  const html = await fetchText(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`);
  if (!html) return [];
  const start = html.indexOf('ytInitialData');
  if (start < 0) return [];
  const json = extractJson(html, html.indexOf('{', start));
  if (!json) return [];
  const results: VideoResult[] = [];
  const seen = new Set<string>();
  walk(json, (node) => {
    const v = node?.videoRenderer;
    if (!v?.videoId || seen.has(v.videoId)) return;
    seen.add(v.videoId);
    results.push({
      id: v.videoId,
      title: runs(v.title) || v.videoId,
      channel: runs(v.ownerText) || runs(v.longBylineText) || undefined,
      duration: (v.lengthText?.simpleText ?? runs(v.lengthText)) || undefined,
      thumbnail: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
    });
  });
  return results.slice(0, limit);
}

function runs(x: any): string {
  if (!x) return '';
  if (typeof x.simpleText === 'string') return x.simpleText;
  if (Array.isArray(x.runs)) return x.runs.map((r: any) => r.text ?? '').join('');
  return '';
}

function walk(node: any, visit: (n: any) => void, depth = 0): void {
  if (!node || typeof node !== 'object' || depth > 40) return;
  visit(node);
  for (const k of Object.keys(node)) walk(node[k], visit, depth + 1);
}

/** Extract a balanced JSON object starting at `from` (handles strings/escapes). */
function extractJson(s: string, from: number): any {
  if (from < 0 || s[from] !== '{') return undefined;
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(from, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
