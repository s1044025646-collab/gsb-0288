import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validatePedigree, computeMatrix, PedigreeError, explainCell } from "../src/pedigree.js";
import { Store } from "../src/db.js";
import * as svc from "../src/service.js";

const EPS = 1e-9;
function build(individuals: { id: string; parent1?: string | null; parent2?: string | null }[]) {
  return computeMatrix(validatePedigree(individuals));
}
function A(r: ReturnType<typeof build>, a: string, b: string): number {
  return r.matrix[r.order.indexOf(a)][r.order.indexOf(b)];
}

// 经典场景：P、Q 创始者 -> C、D 同亲本后代 -> E 为 C×D 后代
const classic = [
  { id: "P" }, { id: "Q" },
  { id: "C", parent1: "P", parent2: "Q" },
  { id: "D", parent1: "P", parent2: "Q" },
  { id: "E", parent1: "C", parent2: "D" },
];

test("同亲本后代 A[C,D]=0.5，亲子 A=0.5", () => {
  const r = build(classic);
  assert.ok(Math.abs(A(r, "C", "D") - 0.5) < EPS);
  assert.ok(Math.abs(A(r, "P", "C") - 0.5) < EPS);
});

test("E 的近交系数 F=0.25 且 A[E,E]=1.25", () => {
  const r = build(classic);
  assert.ok(Math.abs(r.inbreeding["E"] - 0.25) < EPS);
  assert.ok(Math.abs(A(r, "E", "E") - 1.25) < EPS);
});

test("半同胞 A=0.25", () => {
  const r = build([
    { id: "P" }, { id: "Q" }, { id: "R" },
    { id: "C", parent1: "P", parent2: "Q" },
    { id: "D", parent1: "P", parent2: "R" },
  ]);
  assert.ok(Math.abs(A(r, "C", "D") - 0.25) < EPS);
});

test("非近交个体自身亲缘系数 A/2 = 0.5，对角线为 1", () => {
  const r = build(classic);
  assert.ok(Math.abs(A(r, "C", "C") - 1) < EPS);
  assert.ok(Math.abs(A(r, "C", "C") / 2 - 0.5) < EPS);
  assert.ok(Math.abs(r.inbreeding["C"]) < EPS);
});

test("独立创始者之间 A=0", () => {
  const r = build([{ id: "P" }, { id: "Q" }]);
  assert.ok(Math.abs(A(r, "P", "Q")) < EPS);
});

test("未知亲本不共享：两个单亲个体互不相干", () => {
  const r = build([
    { id: "P" },
    { id: "C", parent1: "P", parent2: null },
    { id: "D", parent1: "P", parent2: "" },
    { id: "X", parent1: "C" },
    { id: "Y", parent1: "D" },
  ]);
  assert.ok(Math.abs(A(r, "C", "D") - 0.25) < EPS); // 共享已知亲本 P
  assert.ok(Math.abs(A(r, "C", "C") - 1) < EPS);    // 单亲对角线仍为 1
  assert.ok(Math.abs(r.inbreeding["C"]) < EPS);
});

test("导入顺序不影响结果", () => {
  const a = build(classic);
  const b = build([...classic].reverse());
  assert.deepEqual(a.order, b.order);
  assert.deepEqual(a.matrix, b.matrix);
});

test("拒绝重复编号 / 自身亲本 / 同一亲本 / 坏引用 / 环", () => {
  assert.throws(() => validatePedigree([{ id: "A" }, { id: "A" }]), (e) => (e as PedigreeError).code === "DUPLICATE_ID");
  assert.throws(() => validatePedigree([{ id: "A", parent1: "A" }]), (e) => (e as PedigreeError).code === "SELF_PARENT");
  assert.throws(() => validatePedigree([{ id: "A" }, { id: "B", parent1: "A", parent2: "A" }]), (e) => (e as PedigreeError).code === "SAME_PARENTS");
  assert.throws(() => validatePedigree([{ id: "A", parent1: "ZZZ" }]), (e) => (e as PedigreeError).code === "UNKNOWN_PARENT");
  assert.throws(
    () => validatePedigree([{ id: "A", parent1: "C" }, { id: "B", parent1: "A" }, { id: "C", parent1: "B" }]),
    (e) => (e as PedigreeError).code === "PARENT_CYCLE"
  );
});

test("矩阵对称", () => {
  const r = build(classic);
  for (let i = 0; i < r.order.length; i++)
    for (let j = 0; j < r.order.length; j++)
      assert.ok(Math.abs(r.matrix[i][j] - r.matrix[j][i]) < EPS);
});

test("空家谱与仅创始者家谱", () => {
  const empty = build([]);
  assert.equal(empty.order.length, 0);
  const founders = build([{ id: "P" }, { id: "Q" }]);
  assert.deepEqual(founders.inbreeding, { P: 0, Q: 0 });
});

test("个体数量上限", () => {
  const many = Array.from({ length: 11 }, (_, k) => ({ id: `I${k}` }));
  assert.throws(() => validatePedigree(many, 10), (e) => (e as PedigreeError).code === "TOO_MANY_INDIVIDUALS");
});

test("解释单元展示亲本单元与加权结果", () => {
  const r = build(classic);
  const ex = explainCell(r, "E", "P");
  assert.equal(ex.terms.length, 2);
  assert.ok(Math.abs(ex.terms[0].value - 0.5) < EPS); // A[C,P]=0.5
  assert.ok(Math.abs(ex.value - 0.5) < EPS);
  const diag = explainCell(r, "E", "E");
  assert.equal(diag.kind, "diagonal");
});

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ped-")), "test.db");
}

test("重启后旧版本仍可按原输入查询", () => {
  const db = tmpDb();
  let store = new Store(db);
  const { versionId } = store.importVersion(classic);
  store.close();
  store = new Store(db); // 模拟重启
  const rel = svc.relationship(store, versionId, "C", "D");
  assert.ok(Math.abs(rel.additiveRelationship - 0.5) < EPS);
  assert.ok(Math.abs(svc.inbreeding(store, versionId, "E").F - 0.25) < EPS);
  store.close();
});

test("亲本更正生成新版本，旧版本不变，差异可列出", () => {
  const db = tmpDb();
  const store = new Store(db);
  const v1 = store.importVersion(classic).versionId;
  // 更正：D 的亲本其实是 P 与 R（不再是 P、Q）
  const corrected = [
    { id: "P" }, { id: "Q" }, { id: "R" },
    { id: "C", parent1: "P", parent2: "Q" },
    { id: "D", parent1: "P", parent2: "R" },
    { id: "E", parent1: "C", parent2: "D" },
  ];
  const v2 = store.importVersion(corrected).versionId;
  assert.notEqual(v1, v2);
  // 旧版本仍按原输入
  assert.ok(Math.abs(svc.inbreeding(store, v1, "E").F - 0.25) < EPS);
  // 新版本：C 与 D 为半同胞，A[C,D]=0.25，F[E]=0.125
  assert.ok(Math.abs(svc.inbreeding(store, v2, "E").F - 0.125) < EPS);
  const diff = svc.compareVersions(store, v1, v2);
  const eDiff = diff.inbreedingDiffs.find((d) => d.id === "E");
  assert.ok(eDiff && Math.abs(eDiff.from! - 0.25) < EPS && Math.abs(eDiff.to! - 0.125) < EPS);
  assert.ok(diff.matrixDiffs.some((d) => d.i === "C" && d.j === "D"));
  assert.deepEqual(diff.onlyInTo, ["R"]);
  store.close();
});

test("失败导入不产生任何版本", () => {
  const db = tmpDb();
  const store = new Store(db);
  assert.throws(() => store.importVersion([{ id: "A", parent1: "NOPE" }]));
  assert.equal(store.listVersions().length, 0);
  store.close();
});
