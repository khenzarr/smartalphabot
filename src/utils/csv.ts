export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return escapeCsvCell(value.join('|'));

  const str = String(value);
  const escaped = str.replace(/"/g, '""');
  if (/[",\n\r]/.test(escaped)) return `"${escaped}"`;
  return escaped;
}

export function toCsv<T extends Record<string, unknown>>(rows: T[], columns: Array<keyof T>): string {
  const header = columns.map((c) => escapeCsvCell(c)).join(',');
  const lines = rows.map((row) => columns.map((col) => escapeCsvCell(row[col])).join(','));
  return [header, ...lines].join('\n');
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

export function parseCsv(text: string): Array<Record<string, string>> {
  const lines = text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0] ?? '');
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i += 1) row[headers[i] ?? `col_${i}`] = cells[i] ?? '';
    return row;
  });
}
