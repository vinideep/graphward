/** Parse git status --porcelain=v1 -z. Paths remain literal, including whitespace/newlines. */
export function parseGitStatusPaths(output: string): string[] {
  const records = output.split("\0");
  const paths = new Set<string>();
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4 || record[2] !== " ") continue;
    const status = record.slice(0, 2);
    paths.add(record.slice(3));
    // In -z mode the destination is first, followed by the original path.
    if (/[RC]/.test(status)) {
      const original = records[++i];
      if (original) paths.add(original);
    }
  }
  return [...paths];
}
