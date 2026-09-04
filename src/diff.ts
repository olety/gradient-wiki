// Unified line diff between two revisions. Common prefix and suffix are trimmed first, then
// the middle is aligned with a longest-common-subsequence table. Middles larger than the
// table budget are emitted as a plain replace so a 1 MB page cannot pin the CPU.

const TABLE_BUDGET = 4_000_000;

export function unifiedDiff(aText: string, bText: string, aLabel: string, bLabel: string): string {
  const a = aText.split("\n");
  const b = bText.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const ops = midA.length * midB.length <= TABLE_BUDGET ? lcsOps(midA, midB) : replaceOps(midA, midB);

  const lines = [`--- ${aLabel}`, `+++ ${bLabel}`];
  if (ops.length === 0) return lines.join("\n") + "\n";
  const context = 3;
  const ctxBefore = a.slice(Math.max(0, head - context), head);
  const ctxAfter = a.slice(a.length - tail, a.length - tail + context);
  const removed = ops.filter((o) => o[0] !== "+").length;
  const added = ops.filter((o) => o[0] !== "-").length;
  const aStart = head - ctxBefore.length + 1;
  const bStart = head - ctxBefore.length + 1;
  lines.push(`@@ -${aStart},${ctxBefore.length + removed + ctxAfter.length} +${bStart},${ctxBefore.length + added + ctxAfter.length} @@`);
  for (const l of ctxBefore) lines.push(" " + l);
  for (const [sign, text] of ops) lines.push(sign + text);
  for (const l of ctxAfter) lines.push(" " + l);
  return lines.join("\n") + "\n";
}

type Op = [sign: " " | "-" | "+", text: string];

function replaceOps(a: string[], b: string[]): Op[] {
  return [...a.map<Op>((l) => ["-", l]), ...b.map<Op>((l) => ["+", l])];
}

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i..] and b[j..]
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[at(i, j)] = a[i] === b[j] ? table[at(i + 1, j + 1)]! + 1 : Math.max(table[at(i + 1, j)]!, table[at(i, j + 1)]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push([" ", a[i]!]), i++, j++;
    else if (table[at(i + 1, j)]! >= table[at(i, j + 1)]!) ops.push(["-", a[i]!]), i++;
    else ops.push(["+", b[j]!]), j++;
  }
  while (i < n) ops.push(["-", a[i++]!]);
  while (j < m) ops.push(["+", b[j++]!]);
  return ops;
}
