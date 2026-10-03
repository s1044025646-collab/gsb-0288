import { Store } from "./db.js";
import { PedigreeError, explainCell, type PedigreeResult } from "./pedigree.js";

export const EPSILON = 1e-9; // 双精度浮点比较容限

export function requireResult(store: Store, versionId: number): PedigreeResult {
  const r = store.loadResult(versionId);
  if (!r) throw new PedigreeError("VERSION_NOT_FOUND", `版本不存在: ${versionId}`);
  return r;
}

function indexOf(result: PedigreeResult, id: string): number {
  const k = result.order.indexOf(id);
  if (k < 0) throw new PedigreeError("NOT_FOUND", `个体不存在: ${id}`);
  return k;
}

export function report(store: Store, versionId: number) {
  const v = store.getVersion(versionId);
  const r = requireResult(store, versionId);
  return {
    version: v,
    order: r.order,
    inbreeding: r.inbreeding,
    relationshipCoefficient: Object.fromEntries(r.order.map((id) => [id, r.matrix[r.order.indexOf(id)][r.order.indexOf(id)] / 2])),
    note: "A 为分子亲缘关系矩阵；亲缘系数 = A/2；F 为近交系数 = A[亲本1,亲本2]/2。三者是不同量，不可混用。",
  };
}

export function relationship(store: Store, versionId: number, a: string, b: string) {
  const r = requireResult(store, versionId);
  const ia = indexOf(r, a);
  const ib = indexOf(r, b);
  const A = r.matrix[ia][ib];
  return {
    versionId, a, b,
    additiveRelationship: A,
    coefficientOfRelationship: A / 2,
    inbreedingOfHypotheticalChild: A / 4,
    epsilon: EPSILON,
    note: "A 为分子亲缘关系；亲缘系数为 A/2；二者不是同一数字的换名。",
  };
}

export function inbreeding(store: Store, versionId: number, id: string) {
  const r = requireResult(store, versionId);
  indexOf(r, id);
  return { versionId, id, F: r.inbreeding[id] ?? 0, epsilon: EPSILON };
}

export function cell(store: Store, versionId: number, i: string, j: string) {
  const r = requireResult(store, versionId);
  return explainCell(r, i, j);
}

export function exportMatrix(store: Store, versionId: number) {
  const r = requireResult(store, versionId);
  return { versionId, order: r.order, matrix: r.matrix, inbreeding: r.inbreeding };
}

export function compareVersions(store: Store, fromId: number, toId: number) {
  const a = requireResult(store, fromId);
  const b = requireResult(store, toId);
  const ids = [...new Set([...a.order, ...b.order])].sort();
  const idxA = new Map(a.order.map((id, k) => [id, k]));
  const idxB = new Map(b.order.map((id, k) => [id, k]));
  const inbreedingDiffs: { id: string; from: number | null; to: number | null }[] = [];
  const matrixDiffs: { i: string; j: string; from: number; to: number }[] = [];
  for (const id of ids) {
    const fa = idxA.has(id) ? a.inbreeding[id] ?? 0 : null;
    const fb = idxB.has(id) ? b.inbreeding[id] ?? 0 : null;
    if (fa === null || fb === null || Math.abs(fa - fb) > EPSILON)
      inbreedingDiffs.push({ id, from: fa, to: fb });
  }
  const common = ids.filter((id) => idxA.has(id) && idxB.has(id));
  for (let x = 0; x < common.length; x++) {
    for (let y = x; y < common.length; y++) {
      const va = a.matrix[idxA.get(common[x])!][idxA.get(common[y])!];
      const vb = b.matrix[idxB.get(common[x])!][idxB.get(common[y])!];
      if (Math.abs(va - vb) > EPSILON) matrixDiffs.push({ i: common[x], j: common[y], from: va, to: vb });
    }
  }
  const onlyInFrom = ids.filter((id) => !idxB.has(id));
  const onlyInTo = ids.filter((id) => !idxA.has(id));
  return { fromId, toId, inbreedingDiffs, matrixDiffs, onlyInFrom, onlyInTo, epsilon: EPSILON };
}
