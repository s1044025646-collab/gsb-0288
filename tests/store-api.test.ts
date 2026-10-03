import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PedigreeStore } from "../src/store.js";
import { startServer } from "../src/server.js";
import type { PedigreeInput } from "../src/types.js";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "pedigree-"));
  dirs.push(dir);
  return join(dir, "test.sqlite");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const v1: PedigreeInput = {
  algorithmVersion: "additive-relationship-recursive-v1",
  individuals: [
    { id: "P" },
    { id: "Q" },
    { id: "C", parent1: "P", parent2: "Q" },
    { id: "D", parent1: "P", parent2: "Q" },
    { id: "E", parent1: "C", parent2: "D" },
  ],
};

test("事务失败后不留下版本", () => {
  const dbPath = tempDb();
  const store = new PedigreeStore(dbPath);
  try {
    expect(() =>
      store.importPedigree({
        algorithmVersion: "additive-relationship-recursive-v1",
        individuals: [
          { id: "A", parent1: "B" },
          { id: "B", parent1: "A" },
        ],
      }),
    ).toThrowError(/亲本环/);
    expect(store.listVersions()).toEqual([]);
  } finally {
    store.close();
  }
});

test("重启后旧版本可查，亲本更正生成差异", () => {
  const dbPath = tempDb();
  let store = new PedigreeStore(dbPath);
  try {
    const first = store.importPedigree(v1);
    const corrected: PedigreeInput = {
      algorithmVersion: "additive-relationship-recursive-v1",
      individuals: [
        { id: "P" },
        { id: "Q" },
        { id: "R" },
        { id: "C", parent1: "P", parent2: "Q" },
        { id: "D", parent1: "P", parent2: "R" },
        { id: "E", parent1: "C", parent2: "D" },
      ],
    };
    const second = store.importPedigree(corrected);
    store.close();

    store = new PedigreeStore(dbPath);
    expect(store.getReport(first.versionId)?.inbreeding.E).toBeCloseTo(0.25, 12);
    expect(store.getReport(second.versionId)?.inbreeding.E).toBeCloseTo(0.125, 12);
    const dependency = store.getCell(first.versionId, "E", "E") as
      | { formula: string }
      | null;
    expect(dependency?.formula).toContain("A[C,D]/2");
    const diff = store.compareVersions(first.versionId, second.versionId);
    expect(diff?.inbreedingDiffs.find((item) => item.id === "E")?.delta).toBeCloseTo(
      -0.125,
      12,
    );
    expect(diff?.matrixDiffs).toContainEqual(
      expect.objectContaining({ row: "C", col: "D", from: 0.5, to: 0.25 }),
    );
  } finally {
    store.close();
  }
});

test("HTTP API 提供导入、关系、单元解释和错误码", async () => {
  const running = startServer({ dbPath: tempDb(), port: 0 });
  const base = await running.url;
  try {
    const imported = await fetch(`${base}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(v1),
    });
    expect(imported.status).toBe(201);
    const { version } = (await imported.json()) as { version: { versionId: number } };

    const relationship = await fetch(
      `${base}/versions/${version.versionId}/relationship?a=C&b=D`,
    );
    const relationshipBody = (await relationship.json()) as {
      additiveRelationship: number;
      kinshipCoefficient: number;
    };
    expect(relationshipBody.additiveRelationship).toBe(0.5);
    expect(relationshipBody.kinshipCoefficient).toBe(0.25);

    const bad = await fetch(`${base}/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ individuals: [{ id: "A", parent1: "A" }] }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).code).toBe("SELF_PARENT");
  } finally {
    await new Promise<void>((resolvePromise) => running.server.close(() => resolvePromise()));
    running.store.close();
  }
});
