export const ALGORITHM_VERSION = "tabular-a-v1";
export const DEFAULT_MAX_INDIVIDUALS = 2000;

export interface IndividualInput {
  id: string;
  parent1?: string | null;
  parent2?: string | null;
}

export class PedigreeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function normParent(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t === "" ? null : t;
}

export interface ValidatedIndividual {
  id: string;
  parent1: string | null;
  parent2: string | null;
}

export function validatePedigree(
  raw: IndividualInput[],
  maxIndividuals = DEFAULT_MAX_INDIVIDUALS
): ValidatedIndividual[] {
  if (!Array.isArray(raw)) throw new PedigreeError("BAD_INPUT", "individuals 必须是数组");
  if (raw.length > maxIndividuals)
    throw new PedigreeError("TOO_MANY_INDIVIDUALS", `个体数量 ${raw.length} 超过上限 ${maxIndividuals}`);
  const seen = new Set<string>();
  const out: ValidatedIndividual[] = [];
  for (const item of raw) {
    if (!item || typeof item.id !== "string" || item.id.trim() === "")
      throw new PedigreeError("BAD_ID", "每个个体必须提供非空字符串 id");
    const id = item.id.trim();
    if (seen.has(id)) throw new PedigreeError("DUPLICATE_ID", `重复编号: ${id}`);
    seen.add(id);
    const p1 = normParent(item.parent1);
    const p2 = normParent(item.parent2);
    if (p1 === id || p2 === id) throw new PedigreeError("SELF_PARENT", `个体 ${id} 不能作为自己的亲本`);
    if (p1 !== null && p2 !== null && p1 === p2)
      throw new PedigreeError("SAME_PARENTS", `个体 ${id} 的两个亲本使用了同一编号 ${p1}`);
    out.push({ id, parent1: p1, parent2: p2 });
  }
  for (const ind of out) {
    for (const p of [ind.parent1, ind.parent2]) {
      if (p !== null && !seen.has(p))
        throw new PedigreeError("UNKNOWN_PARENT", `个体 ${ind.id} 引用了不存在的亲本编号 ${p}`);
    }
  }
  // 环检测：亲本必须构成 DAG
  const parentMap = new Map(out.map((i) => [i.id, [i.parent1, i.parent2].filter((x): x is string => x !== null)]));
  const state = new Map<string, number>(); // 0=未访问 1=访问中 2=完成
  const dfs = (id: string, stack: string[]): void => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) throw new PedigreeError("PARENT_CYCLE", `检测到亲本环: ${[...stack, id].join(" -> ")}`);
    state.set(id, 1);
    for (const p of parentMap.get(id) ?? []) dfs(p, [...stack, id]);
    state.set(id, 2);
  };
  for (const ind of out) dfs(ind.id, []);
  return out;
}

// 拓扑排序：亲本先于后代；同代按编号字典序，保证与导入顺序无关
export function computationOrder(individuals: ValidatedIndividual[]): string[] {
  const indeg = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const i of individuals) {
    indeg.set(i.id, 0);
    children.set(i.id, []);
  }
  for (const i of individuals) {
    for (const p of [i.parent1, i.parent2]) {
      if (p !== null) {
        indeg.set(i.id, (indeg.get(i.id) ?? 0) + 1);
        children.get(p)!.push(i.id);
      }
    }
  }
  const ready = individuals.filter((i) => indeg.get(i.id) === 0).map((i) => i.id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const c of children.get(id)!.sort()) {
      const d = indeg.get(c)! - 1;
      indeg.set(c, d);
      if (d === 0) {
        // 保持 ready 有序以得到稳定顺序
        const pos = ready.findIndex((x) => x > c);
        if (pos === -1) ready.push(c); else ready.splice(pos, 0, c);
      }
    }
  }
  if (order.length !== individuals.length)
    throw new PedigreeError("PARENT_CYCLE", "家谱中存在亲本环，无法排序");
  return order;
}

export interface CellExplanation {
  i: string;
  j: string;
  value: number;
  kind: "diagonal" | "offdiagonal" | "founder";
  parents: [string | null, string | null];
  terms: { parent: string | null; cell: [string, string] | null; weight: number; value: number }[];
  note: string;
}

export interface PedigreeResult {
  order: string[];
  matrix: number[][]; // 按 order 排列的 A
  inbreeding: Record<string, number>;
  individuals: ValidatedIndividual[];
}

export function computeMatrix(individuals: ValidatedIndividual[]): PedigreeResult {
  const order = computationOrder(individuals);
  const idx = new Map(order.map((id, k) => [id, k]));
  const byId = new Map(individuals.map((i) => [i.id, i]));
  const n = order.length;
  const A: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const F: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const ind = byId.get(order[i])!;
    const p1 = ind.parent1 !== null ? idx.get(ind.parent1)! : -1;
    const p2 = ind.parent2 !== null ? idx.get(ind.parent2)! : -1;
    for (let j = 0; j < i; j++) {
      let v = 0;
      if (p1 >= 0) v += 0.5 * A[p1][j];
      if (p2 >= 0) v += 0.5 * A[p2][j];
      A[i][j] = v;
      A[j][i] = v;
    }
    if (p1 >= 0 && p2 >= 0) {
      A[i][i] = 1 + A[p1][p2] / 2;
      F[ind.id] = A[p1][p2] / 2;
    } else {
      // 至少一个亲本未知：未知来源视为互不相关的独立创始者
      A[i][i] = 1;
      F[ind.id] = 0;
    }
  }
  return { order, matrix: A, inbreeding: F, individuals };
}

export function explainCell(result: PedigreeResult, i: string, j: string): CellExplanation {
  const idx = new Map(result.order.map((id, k) => [id, k]));
  const a = idx.get(i);
  const b = idx.get(j);
  if (a === undefined) throw new PedigreeError("NOT_FOUND", `个体不存在: ${i}`);
  if (b === undefined) throw new PedigreeError("NOT_FOUND", `个体不存在: ${j}`);
  const byId = new Map(result.individuals.map((x) => [x.id, x]));
  // 统一让 i 是较晚（行）的一方
  const [ri, ci] = a >= b ? [a, b] : [b, a];
  const ind = byId.get(result.order[ri])!;
  const value = result.matrix[ri][ci];
  const jId = result.order[ci];
  const val = (id: string | null): number => (id === null ? 0 : result.matrix[idx.get(id)!][ci]);
  if (ri === ci) {
    const both = ind.parent1 !== null && ind.parent2 !== null;
    return {
      i, j, value, kind: "diagonal",
      parents: [ind.parent1, ind.parent2],
      terms: both
        ? [
            { parent: ind.parent1, cell: [ind.parent1!, ind.parent2!], weight: 0.5, value: result.matrix[idx.get(ind.parent1!)!][idx.get(ind.parent2!)!] },
            { parent: ind.parent2, cell: null, weight: 1, value: 1 },
          ]
        : [],
      note: both
        ? `A[${i},${i}] = 1 + A[${ind.parent1},${ind.parent2}]/2 = 1 + ${result.matrix[idx.get(ind.parent1!)!][idx.get(ind.parent2!)!]}/2`
        : `至少一个亲本未知，按互不相关未知来源处理：A[${i},${i}] = 1，F = 0`,
    };
  }
  const terms = [
    { parent: ind.parent1, cell: ind.parent1 !== null ? ([ind.parent1, jId] as [string, string]) : null, weight: 0.5, value: val(ind.parent1) },
    { parent: ind.parent2, cell: ind.parent2 !== null ? ([ind.parent2, jId] as [string, string]) : null, weight: 0.5, value: val(ind.parent2) },
  ];
  const isFounder = ind.parent1 === null && ind.parent2 === null;
  return {
    i, j, value, kind: isFounder ? "founder" : "offdiagonal",
    parents: [ind.parent1, ind.parent2],
    terms,
    note: isFounder
      ? `${ind.id} 是创始个体，与无后代关系的其他创始者按互不相关处理`
      : `A[${ind.id},${jId}] = 0.5*A[${ind.parent1 ?? "?"},${jId}] + 0.5*A[${ind.parent2 ?? "?"},${jId}]（未知亲本项为 0）= ${value}`,
  };
}
