// 演示：导入经典家谱 -> 更正亲本 -> 比较两个版本
import { Store } from "../dist/src/db.js";
import * as svc from "../dist/src/service.js";
import * as fs from "node:fs";

fs.rmSync("data/demo.db", { force: true });
const store = new Store("data/demo.db");

const v1 = store.importVersion([
  { id: "P" }, { id: "Q" },
  { id: "C", parent1: "P", parent2: "Q" },
  { id: "D", parent1: "P", parent2: "Q" },
  { id: "E", parent1: "C", parent2: "D" },
]).versionId;
console.log(`版本 ${v1}: C,D 同亲本(P,Q)，E 为 C×D 后代`);
console.log("  A[C,D] =", svc.relationship(store, v1, "C", "D").additiveRelationship);
console.log("  F[E]   =", svc.inbreeding(store, v1, "E").F);

const v2 = store.importVersion([
  { id: "P" }, { id: "Q" }, { id: "R" },
  { id: "C", parent1: "P", parent2: "Q" },
  { id: "D", parent1: "P", parent2: "R" }, // 更正：D 的第二亲本是 R
  { id: "E", parent1: "C", parent2: "D" },
]).versionId;
console.log(`\n版本 ${v2}: 更正 D 的亲本为 (P,R)`);
console.log("  A[C,D] =", svc.relationship(store, v2, "C", "D").additiveRelationship);
console.log("  F[E]   =", svc.inbreeding(store, v2, "E").F);

console.log("\n版本差异 (v1 -> v2):");
console.log(JSON.stringify(svc.compareVersions(store, v1, v2), null, 2));
store.close();
