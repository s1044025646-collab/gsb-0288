import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "./db.js";
import { PedigreeError } from "./pedigree.js";
import * as svc from "./service.js";

const DATA_DIR = process.env.PEDIGREE_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.PEDIGREE_DB ?? path.join(DATA_DIR, "pedigree.db");

function usage(): never {
  console.log(`用法: node dist/src/cli.js <命令> [参数]
  import <file.json>                导入家谱 JSON（{individuals:[{id,parent1,parent2}]}），生成新版本
  versions                          列出所有版本
  report <versionId>                查看计算报告
  relationship <versionId> <a> <b>  查询两人亲缘关系
  inbreeding <versionId> <id>       查询个体近交系数
  cell <versionId> <i> <j>          查看矩阵单元递推依赖
  matrix <versionId>                导出矩阵 JSON
  compare <fromId> <toId>           比较两个版本`);
  process.exit(1);
}

function fail(e: unknown): never {
  if (e instanceof PedigreeError) {
    console.error(`错误 [${e.code}] ${e.message}`);
    process.exit(2);
  }
  throw e;
}

const [, , cmd, ...args] = process.argv;
if (!cmd) usage();

const store = new Store(DB_PATH);
try {
  switch (cmd) {
    case "import": {
      const file = args[0];
      if (!file) usage();
      const body = JSON.parse(fs.readFileSync(file, "utf8"));
      const { versionId, result } = store.importVersion(body.individuals ?? body);
      console.log(JSON.stringify({ versionId, individualCount: result.order.length, order: result.order }, null, 2));
      break;
    }
    case "versions":
      console.log(JSON.stringify(store.listVersions(), null, 2));
      break;
    case "report":
      console.log(JSON.stringify(svc.report(store, Number(args[0])), null, 2));
      break;
    case "relationship":
      console.log(JSON.stringify(svc.relationship(store, Number(args[0]), args[1], args[2]), null, 2));
      break;
    case "inbreeding":
      console.log(JSON.stringify(svc.inbreeding(store, Number(args[0]), args[1]), null, 2));
      break;
    case "cell":
      console.log(JSON.stringify(svc.cell(store, Number(args[0]), args[1], args[2]), null, 2));
      break;
    case "matrix":
      console.log(JSON.stringify(svc.exportMatrix(store, Number(args[0])), null, 2));
      break;
    case "compare":
      console.log(JSON.stringify(svc.compareVersions(store, Number(args[0]), Number(args[1])), null, 2));
      break;
    default:
      usage();
  }
} catch (e) {
  fail(e);
} finally {
  store.close();
}
