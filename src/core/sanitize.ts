// Scanned metadata is untrusted: sanitize file names before display/download
// so a malicious sender cannot smuggle path separators, control characters,
// or deceptive names (e.g. "....", absolute paths, "file.exe " tricks).

/** Strip path separators + control chars; never return an empty name. */
export function sanitizeFileName(raw: string): string {
  let name = raw.replace(/[\\/]/g, '_');
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f\x7f]/g, '');
  name = name.trim().replace(/^\.+/, '');
  if (name === '' || name === '.' || name === '..') return 'download.bin';
  if (name.length > 100) name = name.slice(0, 100);
  return name;
}
