import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { PedigreeStore } from "../src/store.js";

const dbPath = resolve("data/demo.sqlite");
rmSync(dbPath, { force: true });
rmSync(`${dbPath}-wal`, { force: true });
rmSync(`${dbPath}-shm`, { force: true });

const store = new PedigreeStore(dbPath);
const v1 = store.importPedigree(
  JSON.parse(String.raw`{"algorithmVersion":"additive-relationship-recursive-v1","note":"全同胞后近交","individuals":[{"id":"P","parent1":null,"parent2":null},{"id":"Q","parent1":null,"parent2":null},{"id":"C","parent1":"P","parent2":"Q"},{"id":"D","parent1":"P","parent2":"Q"},{"id":"E","parent1":"C","parent2":"D"}]}`),
);
const v2 = store.importPedigree(
  JSON.parse(String.raw`{"algorithmVersion":"additive-relationship-recursive-v1","note":"D 更正为半同胞","individuals":[{"id":"P","parent1":null,"parent2":null},{"id":"Q","parent1":null,"parent2":null},{"id":"R","parent1":null,"parent2":null},{"id":"C","parent1":"P","parent2":"Q"},{"id":"D","parent1":"P","parent2":"R"},{"id":"E","parent1":"C","parent2":"D"}]}`),
);
const r1 = store.getReport(v1.versionId)!;
const r2 = store.getReport(v2.versionId)!;
console.log("v1", v1.versionId, "A[C,D] =", r1.matrix.C.D, "F[E] =", r1.inbreeding.E, "A[E,E] =", r1.matrix.E.E);
console.log("v2", v2.versionId, "A[C,D] =", r2.matrix.C.D, "F[E] =", r2.inbreeding.E, "A[E,E] =", r2.matrix.E.E);
console.log("E 近交差异:", store.compareVersions(v1.versionId, v2.versionId)?.inbreedingDiffs);
console.log("数据库:", dbPath);
store.close();
