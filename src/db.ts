import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ALGORITHM_VERSION,
  computeMatrix,
  validatePedigree,
  type IndividualInput,
  type PedigreeResult,
} from "./pedigree.js";

export interface VersionRow {
  id: number;
  created_at: string;
  algorithm: string;
  assumptions: string;
  individual_count: number;
}

export const ASSUMPTIONS =
  "创始个体互不相关且非近交；未知亲本视为互不相关的独立未知来源（不共享祖先）；亲本位置仅表示两个来源，不含性别含义；数值为双精度浮点近似，非遗传测量值。";

export class Store {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        assumptions TEXT NOT NULL,
        individual_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS individuals (
        version_id INTEGER NOT NULL REFERENCES versions(id),
        id TEXT NOT NULL,
        parent1 TEXT,
        parent2 TEXT,
        position INTEGER NOT NULL,
        PRIMARY KEY (version_id, id)
      );
      CREATE TABLE IF NOT EXISTS matrices (
        version_id INTEGER PRIMARY KEY REFERENCES versions(id),
        order_json TEXT NOT NULL,
        matrix_json TEXT NOT NULL,
        inbreeding_json TEXT NOT NULL
      );
    `);
  }

  close(): void { this.db.close(); }

  // 先完整验证并计算，全部成功后才在单事务中写入；失败不落任何数据
  importVersion(raw: IndividualInput[], maxIndividuals?: number): { versionId: number; result: PedigreeResult } {
    const validated = validatePedigree(raw, maxIndividuals);
    const result = computeMatrix(validated); // 计算失败则不会进入写库
    const insertV = this.db.prepare(
      "INSERT INTO versions (created_at, algorithm, assumptions, individual_count) VALUES (?, ?, ?, ?)"
    );
    const insertI = this.db.prepare(
      "INSERT INTO individuals (version_id, id, parent1, parent2, position) VALUES (?, ?, ?, ?, ?)"
    );
    const insertM = this.db.prepare(
      "INSERT INTO matrices (version_id, order_json, matrix_json, inbreeding_json) VALUES (?, ?, ?, ?)"
    );
    this.db.exec("BEGIN");
    try {
      const r = insertV.run(new Date().toISOString(), ALGORITHM_VERSION, ASSUMPTIONS, validated.length);
      const versionId = Number(r.lastInsertRowid);
      result.order.forEach((id, pos) => {
        const ind = validated.find((x) => x.id === id)!;
        insertI.run(versionId, ind.id, ind.parent1, ind.parent2, pos);
      });
      insertM.run(versionId, JSON.stringify(result.order), JSON.stringify(result.matrix), JSON.stringify(result.inbreeding));
      this.db.exec("COMMIT");
      return { versionId, result };
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  listVersions(): VersionRow[] {
    return this.db.prepare("SELECT * FROM versions ORDER BY id").all() as unknown as VersionRow[];
  }

  getVersion(versionId: number): VersionRow | null {
    return (this.db.prepare("SELECT * FROM versions WHERE id = ?").get(versionId) as unknown as VersionRow) ?? null;
  }

  loadResult(versionId: number): PedigreeResult | null {
    const m = this.db.prepare("SELECT * FROM matrices WHERE version_id = ?").get(versionId) as
      | { order_json: string; matrix_json: string; inbreeding_json: string } | undefined;
    if (!m) return null;
    const individuals = this.db
      .prepare("SELECT id, parent1, parent2 FROM individuals WHERE version_id = ? ORDER BY position")
      .all(versionId) as unknown as { id: string; parent1: string | null; parent2: string | null }[];
    return {
      order: JSON.parse(m.order_json),
      matrix: JSON.parse(m.matrix_json),
      inbreeding: JSON.parse(m.inbreeding_json),
      individuals,
    };
  }
}
