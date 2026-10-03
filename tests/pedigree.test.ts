import { describe, expect, test } from "vitest";
import { computeRelationshipMatrix, validatePedigree } from "../src/pedigree.js";

function run(individuals: Array<Record<string, unknown>>) {
  return computeRelationshipMatrix(
    validatePedigree({ individuals }) as ReturnType<typeof validatePedigree>,
  );
}

describe("分子亲缘关系矩阵递推", () => {
  test("全同胞、亲子与后代近交", () => {
    const result = run([
      { id: "P" },
      { id: "Q" },
      { id: "C", parent1: "P", parent2: "Q" },
      { id: "D", parent1: "P", parent2: "Q" },
      { id: "E", parent1: "C", parent2: "D" },
    ]);
    expect(result.matrix.P.Q).toBe(0);
    expect(result.matrix.C.P).toBe(0.5);
    expect(result.matrix.C.D).toBeCloseTo(0.5, 12);
    expect(result.matrix.C.C / 2).toBe(0.5);
    expect(result.inbreeding.E).toBeCloseTo(0.25, 12);
    expect(result.matrix.E.E).toBeCloseTo(1.25, 12);
    expect(result.matrix.C.C).toBe(1);
    expect(result.inbreeding.C).toBe(0);
  });

  test("半同胞为 0.25，单已知亲本对角线为 1", () => {
    const result = run([
      { id: "P" },
      { id: "Q" },
      { id: "R" },
      { id: "C", parent1: "P", parent2: "Q" },
      { id: "D", parent1: "P", parent2: "R" },
      { id: "X", parent1: "P" },
    ]);
    expect(result.matrix.C.D).toBeCloseTo(0.25, 12);
    expect(result.matrix.X.P).toBe(0.5);
    expect(result.matrix.X.X).toBe(1);
    expect(result.inbreeding.X).toBe(0);
    expect(result.matrix.X.Q).toBe(0);
  });

  test("空家谱和只有创始者行为明确", () => {
    const empty = run([]);
    expect(empty.order).toEqual([]);
    expect(empty.matrix).toEqual({});
    const founders = run([{ id: "Q" }, { id: "P" }]);
    expect(founders.order).toEqual(["P", "Q"]);
    expect(founders.matrix.P.P).toBe(1);
    expect(founders.matrix.P.Q).toBe(0);
  });

  test("输入重排不影响结果，矩阵对称", () => {
    const a = run([
      { id: "E", parent1: "C", parent2: "D" },
      { id: "D", parent1: "P", parent2: "Q" },
      { id: "C", parent1: "P", parent2: "Q" },
      { id: "Q" },
      { id: "P" },
    ]);
    const b = run([
      { id: "P" },
      { id: "Q" },
      { id: "C", parent1: "Q", parent2: "P" },
      { id: "D", parent1: "Q", parent2: "P" },
      { id: "E", parent1: "D", parent2: "C" },
    ]);
    for (const x of ["P", "Q", "C", "D", "E"]) {
      for (const y of ["P", "Q", "C", "D", "E"]) {
        expect(a.matrix[x][y]).toBeCloseTo(b.matrix[x][y], 12);
        expect(a.matrix[x][y]).toBeCloseTo(a.matrix[y][x], 12);
      }
    }
  });

  test("不同空亲本不共享祖先", () => {
    const result = run([
      { id: "P" },
      { id: "Q" },
      { id: "C", parent1: "P" },
      { id: "D", parent2: "Q" },
      { id: "X", parent1: "C" },
      { id: "Y", parent2: "D" },
    ]);
    expect(result.matrix.C.D).toBe(0);
    expect(result.matrix.X.Y).toBe(0);
  });

  test.each([
    ["重复编号", [{ id: "P" }, { id: "P" }], "DUPLICATE_ID"],
    ["自身亲本", [{ id: "P", parent1: "P" }], "SELF_PARENT"],
    ["相同亲本", [{ id: "P" }, { id: "C", parent1: "P", parent2: "P" }], "DUPLICATE_PARENT"],
    ["坏引用", [{ id: "C", parent1: "P", parent2: "Q" }], "MISSING_PARENT_REFERENCE"],
    [
      "亲本环",
      [
        { id: "A", parent1: "C" },
        { id: "B", parent1: "A" },
        { id: "C", parent1: "B" },
      ],
      "PARENT_CYCLE",
    ],
  ])("拒绝%s", (_name, individuals, code) => {
    expect(() => validatePedigree({ individuals })).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  test("单元解释只列直接亲本单元", () => {
    const result = run([
      { id: "P" },
      { id: "Q" },
      { id: "C", parent1: "P", parent2: "Q" },
    ]);
    const offDiagonal = result.dependencies["C\u0000P"];
    expect(offDiagonal.directParentCells.map((term) => term.cell)).toEqual([
      "A[P,P]",
      "A[Q,P]",
    ]);
    expect(offDiagonal.explanation).toContain("0.5");
  });
});
