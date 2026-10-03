import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ALGORITHM_VERSION,
  computeRelationshipMatrix,
  PedigreeValidationError,
  validatePedigree,
} from "./pedigree.js";
import type { ComputationResult, PedigreeInput } from "./types.js";

export interface ImportedVersion {
  versionId: number;
  createdAt: string;
  note: string | null;
  individualCount: number;
  algorithmVersion: string;
}

export interface VersionDetail extends ImportedVersion {
  individuals: Array<{
    id: string;
    parent1: string | null;
    parent2: string | null;
  }>;
  assumptions: string[];
}

interface MatrixRow {
  version_id: number;
  row_id: string;
  col_id: string;
  value: number;
}

export class PedigreeStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.init();
  }

  close(): void {
    this.db.close();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS versions (
        version_id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        note TEXT,
        algorithm_version TEXT NOT NULL,
        assumptions_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS individuals (
        version_id INTEGER NOT NULL REFERENCES versions(version_id) ON DELETE CASCADE,
        individual_id TEXT NOT NULL,
        parent1 TEXT,
        parent2 TEXT,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (version_id, individual_id)
      );
      CREATE TABLE IF NOT EXISTS computation_order (
        version_id INTEGER NOT NULL REFERENCES versions(version_id) ON DELETE CASCADE,
        individual_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (version_id, individual_id)
      );
      CREATE TABLE IF NOT EXISTS matrix_cells (
        version_id INTEGER NOT NULL REFERENCES versions(version_id) ON DELETE CASCADE,
        row_id TEXT NOT NULL,
        col_id TEXT NOT NULL,
        value REAL NOT NULL,
        PRIMARY KEY (version_id, row_id, col_id)
      );
      CREATE TABLE IF NOT EXISTS inbreeding (
        version_id INTEGER NOT NULL REFERENCES versions(version_id) ON DELETE CASCADE,
        individual_id TEXT NOT NULL,
        value REAL NOT NULL,
        PRIMARY KEY (version_id, individual_id)
      );
      CREATE TABLE IF NOT EXISTS dependencies (
        version_id INTEGER NOT NULL REFERENCES versions(version_id) ON DELETE CASCADE,
        row_id TEXT NOT NULL,
        col_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (version_id, row_id, col_id)
      );
    `);
  }

  importPedigree(input: PedigreeInput): ImportedVersion {
    const algorithmVersion =
      typeof input.algorithmVersion === "string" && input.algorithmVersion.trim()
        ? input.algorithmVersion.trim()
        : ALGORITHM_VERSION;
    if (algorithmVersion !== ALGORITHM_VERSION) {
      throw new PedigreeValidationError(
        "UNSUPPORTED_ALGORITHM_VERSION",
        `当前服务支持 ${ALGORITHM_VERSION}。`,
        { received: algorithmVersion },
      );
    }

    const people = validatePedigree(input);
    const computed = computeRelationshipMatrix(people);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.runImport(input, algorithmVersion, people, computed);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private runImport(
    input: PedigreeInput,
    algorithmVersion: string,
    people: ReturnType<typeof validatePedigree>,
    computed: ComputationResult,
  ): ImportedVersion {
    {
      const createdAt = new Date().toISOString();
      const note = typeof input.note === "string" ? input.note : null;
      const assumptions = assumptionsList();
      const result = this.db
        .prepare(
          `INSERT INTO versions (created_at, note, algorithm_version, assumptions_json)
           VALUES (?, ?, ?, ?)`,
        )
        .run(createdAt, note, algorithmVersion, JSON.stringify(assumptions));
      const versionId = Number((result as { lastInsertRowid: bigint }).lastInsertRowid);

      const insertPerson = this.db.prepare(
        `INSERT INTO individuals (version_id, individual_id, parent1, parent2, ordinal)
         VALUES (?, ?, ?, ?, ?)`,
      );
      people.forEach((person, index) => {
        insertPerson.run(versionId, person.id, person.parent1, person.parent2, index);
      });

      const insertOrder = this.db.prepare(
        `INSERT INTO computation_order (version_id, individual_id, position) VALUES (?, ?, ?)`,
      );
      computed.order.forEach((id, position) => insertOrder.run(versionId, id, position));

      this.persistComputation(versionId, computed);
      return {
        versionId,
        createdAt,
        note,
        individualCount: people.length,
        algorithmVersion,
      };
    }
  }

  private persistComputation(versionId: number, computed: ComputationResult): void {
    const insertCell = this.db.prepare(
      `INSERT INTO matrix_cells (version_id, row_id, col_id, value) VALUES (?, ?, ?, ?)`,
    );
    const insertF = this.db.prepare(
      `INSERT INTO inbreeding (version_id, individual_id, value) VALUES (?, ?, ?)`,
    );
    const insertDep = this.db.prepare(
      `INSERT INTO dependencies (version_id, row_id, col_id, payload_json) VALUES (?, ?, ?, ?)`,
    );

    const seen = new Set<string>();
    for (const rowId of computed.order) {
      for (const colId of computed.order) {
        const pairId = rowId <= colId ? `${rowId}\u0000${colId}` : `${colId}\u0000${rowId}`;
        if (seen.has(pairId)) continue;
        seen.add(pairId);
        const value = computed.matrix[rowId]?.[colId];
        if (value === undefined) throw new Error("内部错误：矩阵缺项。");
        insertCell.run(versionId, rowId, colId, value);
        if (rowId !== colId) insertCell.run(versionId, colId, rowId, value);
      }
      insertF.run(versionId, rowId, computed.inbreeding[rowId] ?? 0);
    }

    for (const dependency of Object.values(computed.dependencies)) {
      insertDep.run(
        versionId,
        dependency.row,
        dependency.col,
        JSON.stringify(dependency),
      );
    }
  }

  listVersions(): ImportedVersion[] {
    const rows = this.db
      .prepare(
        `SELECT v.version_id, v.created_at, v.note, v.algorithm_version,
                COUNT(i.individual_id) AS individual_count
         FROM versions v LEFT JOIN individuals i ON i.version_id = v.version_id
         GROUP BY v.version_id ORDER BY v.version_id`,
      )
      .all() as Array<{
      version_id: number;
      created_at: string;
      note: string | null;
      algorithm_version: string;
      individual_count: number;
    }>;
    return rows.map((row) => ({
      versionId: row.version_id,
      createdAt: row.created_at,
      note: row.note,
      algorithmVersion: row.algorithm_version,
      individualCount: row.individual_count,
    }));
  }

  getVersion(versionId: number): VersionDetail | null {
    const version = this.db
      .prepare(
        `SELECT version_id, created_at, note, algorithm_version, assumptions_json
         FROM versions WHERE version_id = ?`,
      )
      .get(versionId) as
      | {
          version_id: number;
          created_at: string;
          note: string | null;
          algorithm_version: string;
          assumptions_json: string;
        }
      | undefined;
    if (!version) return null;

    const individuals = this.db
      .prepare(
        `SELECT individual_id, parent1, parent2 FROM individuals
         WHERE version_id = ? ORDER BY ordinal`,
      )
      .all(versionId) as Array<{
      individual_id: string;
      parent1: string | null;
      parent2: string | null;
    }>;
    return {
      versionId: version.version_id,
      createdAt: version.created_at,
      note: version.note,
      algorithmVersion: version.algorithm_version,
      individualCount: individuals.length,
      assumptions: JSON.parse(version.assumptions_json) as string[],
      individuals: individuals.map((row) => ({
        id: row.individual_id,
        parent1: row.parent1,
        parent2: row.parent2,
      })),
    };
  }

  getReport(versionId: number) {
    const version = this.getVersion(versionId);
    if (!version) return null;
    const order = (
      this.db
        .prepare(
          `SELECT individual_id FROM computation_order WHERE version_id = ? ORDER BY position`,
        )
        .all(versionId) as Array<{ individual_id: string }>
    ).map((row) => row.individual_id);
    const cells = this.db
      .prepare(
        `SELECT row_id, col_id, value FROM matrix_cells WHERE version_id = ?`,
      )
      .all(versionId) as unknown as MatrixRow[];
    const matrix: Record<string, Record<string, number>> = {};
    for (const cell of cells) {
      matrix[cell.row_id] ??= {};
      matrix[cell.row_id][cell.col_id] = cell.value;
    }
    const fRows = this.db
      .prepare(`SELECT individual_id, value FROM inbreeding WHERE version_id = ?`)
      .all(versionId) as Array<{ individual_id: string; value: number }>;
    const inbreeding = Object.fromEntries(
      fRows.map((row) => [row.individual_id, row.value]),
    );
    return {
      ...version,
      order,
      matrix,
      inbreeding,
      numericalTolerance:
        "矩阵使用 IEEE-754 双精度浮点递推；展示将绝对值小于 1e-12 的数归零。结果是家谱模型量，不是遗传测量值。",
    };
  }

  getCell(versionId: number, rowId: string, colId: string) {
    const pair = rowId <= colId ? [rowId, colId] : [colId, rowId];
    const row = this.db
      .prepare(
        `SELECT payload_json FROM dependencies
         WHERE version_id = ? AND row_id = ? AND col_id = ?`,
      )
      .get(versionId, pair[0], pair[1]) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as object) : null;
  }

  compareVersions(leftId: number, rightId: number) {
    const left = this.getVersion(leftId);
    const right = this.getVersion(rightId);
    if (!left || !right) return null;

    const cell = (versionId: number, row: string, col: string): number | undefined =>
      (
        this.db
          .prepare(
            `SELECT value FROM matrix_cells WHERE version_id = ? AND row_id = ? AND col_id = ?`,
          )
          .get(versionId, row, col) as MatrixRow | undefined
      )?.value;
    const f = (versionId: number, id: string): number | undefined =>
      (
        this.db
          .prepare(
            `SELECT value FROM inbreeding WHERE version_id = ? AND individual_id = ?`,
          )
          .get(versionId, id) as { value: number } | undefined
      )?.value;

    const ids = new Set([
      ...left.individuals.map((person) => person.id),
      ...right.individuals.map((person) => person.id),
    ]);
    const matrixDiffs: Array<{
      row: string;
      col: string;
      from: number | null;
      to: number | null;
      delta: number | null;
    }> = [];
    const inbreedingDiffs: Array<{
      id: string;
      from: number | null;
      to: number | null;
      delta: number | null;
    }> = [];

    for (const id of [...ids].sort()) {
      const fromF = f(leftId, id);
      const toF = f(rightId, id);
      if (fromF !== toF) {
        inbreedingDiffs.push({
          id,
          from: fromF ?? null,
          to: toF ?? null,
          delta: fromF === undefined || toF === undefined ? null : toF - fromF,
        });
      }
    }

    const sortedIds = [...ids].sort();
    for (const row of sortedIds) {
      for (const col of sortedIds) {
        const from = cell(leftId, row, col);
        const to = cell(rightId, row, col);
        if (from !== to) {
          matrixDiffs.push({
            row,
            col,
            from: from ?? null,
            to: to ?? null,
            delta: from === undefined || to === undefined ? null : to - from,
          });
        }
      }
    }

    return {
      fromVersion: leftId,
      toVersion: rightId,
      addedIndividuals: right.individuals
        .filter((person) => !ids.has(person.id) || !left.individuals.some((x) => x.id === person.id))
        .map((person) => person.id),
      removedIndividuals: left.individuals
        .filter((person) => !right.individuals.some((x) => x.id === person.id))
        .map((person) => person.id),
      inbreedingDiffs,
      matrixDiffs,
    };
  }
}

export function assumptionsList(): string[] {
  return [
    "创始个体之间按互不相关处理。",
    "空亲本表示未知来源；不同空值不表示同一个共同祖先。",
    "至少一个亲本未知时，该未知来源按与现有家系互不相关处理，F=0 且对角线 A=1。",
    "亲本位置仅表示两个来源，不建立或推断性别系统。",
    "结果为基于所报家谱的数学量；不用于疾病预测、血缘鉴定或生活建议。",
  ];
}
