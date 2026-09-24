export interface ColumnStats {
  name: string;
  numeric: boolean;
  count: number;
  sum?: number;
  min?: number;
  max?: number;
  mean?: number;
}

export interface TabularStats {
  chunk: { rowStart: number; rowEnd: number };
  rows: number;
  columns: ColumnStats[];
}

/** Split one CSV/TSV/JSONL line into cells (quote-aware enough for v1). */
export function parseLine(line: string, delimiter = ","): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

const NUMERIC = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * tabular-stats: row count + per-column numeric statistics over one chunk's
 * slice. The header row arrives in the chunk manifest; data rows are the
 * downloaded byte range.
 */
export function runTabularStats(
  chunkText: string,
  header: string,
  rowStart: number,
  rowEnd: number,
): TabularStats {
  const headerCols = parseLine(header);
  const columnCount = headerCols.length;

  const numericFlags = new Array<boolean>(columnCount).fill(false);
  const counts = new Array<number>(columnCount).fill(0);
  const sums = new Array<number>(columnCount).fill(0);
  const mins = new Array<number>(columnCount).fill(Infinity);
  const maxs = new Array<number>(columnCount).fill(-Infinity);

  let rows = 0;
  let decided = false;

  for (const line of chunkText.split("\n")) {
    if (line.trim() === "") continue;
    const cells = parseLine(line);
    if (!decided) {
      for (let i = 0; i < columnCount; i++) {
        numericFlags[i] = NUMERIC.test(cells[i] ?? "");
      }
      decided = true;
    }
    rows++;
    for (let i = 0; i < columnCount; i++) {
      if (!numericFlags[i]) continue;
      const value = Number(cells[i]);
      if (Number.isFinite(value)) {
        counts[i]++;
        sums[i] += value;
        mins[i] = Math.min(mins[i], value);
        maxs[i] = Math.max(maxs[i], value);
      }
    }
  }

  const columns: ColumnStats[] = headerCols.map((name, i) => {
    if (numericFlags[i]) {
      const mean = counts[i] > 0 ? round(sums[i] / counts[i]) : null;
      return {
        name,
        numeric: true,
        count: counts[i],
        sum: round(sums[i]),
        min: round(mins[i]),
        max: round(maxs[i]),
        mean: mean ?? undefined,
      };
    }
    return { name, numeric: false, count: rows };
  });

  return {
    chunk: { rowStart, rowEnd },
    rows,
    columns,
  };
}