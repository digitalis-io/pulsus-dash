/** Joins CSS module class names, skipping missing ones (CSS module lookups may be undefined). */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter((n): n is string => typeof n === 'string' && n !== '').join(' ');
}
