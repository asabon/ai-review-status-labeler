/**
 * Compare two commit SHAs allowing abbreviated (7+ char) prefixes.
 */
export function commitShasMatch(expectedSha: string, actualSha: string): boolean {
  const a = expectedSha.toLowerCase();
  const b = actualSha.toLowerCase();
  return a === b || a.startsWith(b) || b.startsWith(a);
}
