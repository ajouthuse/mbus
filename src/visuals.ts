import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { isAbsolute, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const visualInput = z.strictObject({
  path: z.string().min(1).max(4096), title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).default(''), message_id: z.string().min(1).max(128),
});
export interface Visual {
  id: string; room_id: string; room: string; title: string; description: string;
  author: string; peer_id: string; mime: string; bytes: number; hash: string; at: number;
}

/** Snapshot only explicitly submitted media; never expose arbitrary paths over HTTP. */
export function readVisual(path: string) {
  if (!isAbsolute(path)) throw new Error('Provide an absolute local media path.');
  const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
  const mime = types[extname(path).toLowerCase()];
  if (!mime) throw new Error('Supported media: PNG, JPEG, WebP, GIF, MP4, WebM.');
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 4 || stat.size > 64 * 1024 * 1024) throw new Error('Submit a regular media file up to 64 MiB.');
    const data = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < data.length) {
      const count = readSync(fd, data, offset, data.length - offset, offset);
      if (!count) throw new Error('Media changed while reading; retry the submission.');
      offset += count;
    }
    const valid = mime === 'image/png' ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : mime === 'image/jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255
      : mime === 'image/gif' ? /^GIF8[79]a$/.test(data.toString('ascii', 0, 6))
      : mime === 'image/webp' ? data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
      : mime === 'video/mp4' ? data.toString('ascii', 4, 8) === 'ftyp'
      : data.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'));
    if (!valid) throw new Error('Media header does not match its file extension.');
    return { data, mime, hash: createHash('sha256').update(data).digest('hex') };
  } finally { closeSync(fd); }
}
