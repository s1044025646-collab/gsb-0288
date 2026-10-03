#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolveDbPath, startServer } from "./server.js";
import { PedigreeStore } from "./store.js";
import { ALGORITHM_VERSION, formatNumber } from "./pedigree.js";
import type { PedigreeInput } from "./types.js";

interface CliOptions {
  db: string;
}

function parseOptions(args: string[]): { command: string; rest: string[]; options: CliOptions } {
  let db = resolveDbPath(process.env.PEDIGREE_DB);
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--db") {
      db = resolveDbPath(args[index + 1]);
      index += 1;
    } else if (args[index]?.startsWith("--db=")) {
      db = resolveDbPath(args[index].slice("--db=".length));
    } else {
      rest.push(args[index]);
    }
  }
  return { command: rest[0] ?? "help", rest: rest.slice(1), options: { db } };
}

function readInput(fileOrJson: string): PedigreeInput {
  let text: string;
  try {
    text = readFileSync(fileOrJson, "utf8");
  } catch {
    text = fileOrJson;
  }
  return JSON.parse(text) as PedigreeInput;
}

function printMatrix(report: NonNullable<ReturnType<PedigreeStore["getReport"]>>): void {
  console.log(`版本 ${report.versionId}｜顺序: ${report.order.join(", ")}`);
  console.log("\t" + report.order.join("\t"));
  for (const row of report.order) {
    console.log(
      row + "\t" + report.order.map((col) => formatNumber(report.matrix[row][col])).join("\t"),
    );
  }
  console.log("\n近交系数:");
  for (const id of report.order) {
    console.log(`F[${id}]=${formatNumber(report.inbreeding[id])}`);
  }
}

function printHelp(): void {
  console.log(`家谱亲缘矩阵与近交系数服务

用法:
  npm run demo
  node dist/src/cli.js import <file.json|inline-json> [--db data/p.sqlite]
  node dist/src/cli.js report <versionId>
  node dist/src/cli.js relationship <versionId> <a> <b>
  node dist/src/cli.js inbreeding <versionId> <id>
  node dist/src/cli.js cell <versionId> <row> <col>
  node dist/src/cli.js export <versionId> [out.json]
  node dist/src/cli.js compare <fromVersionId> <toVersionId>
  node dist/src/cli.js serve [--port 0] [--host 127.0.0.1] [--db ...]

算法: ${ALGORITHM_VERSION}
`);
}

async function main(): Promise<void> {
  const parsed = parseOptions(process.argv.slice(2));
  const [command, ...args] = [parsed.command, ...parsed.rest];

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "serve") {
    const portIndex = args.indexOf("--port");
    const hostIndex = args.indexOf("--host");
    const port = portIndex >= 0 ? Number(args[portIndex + 1]) : Number(process.env.PORT ?? 0);
    const host = hostIndex >= 0 ? String(args[hostIndex + 1]) : "127.0.0.1";
    const { url } = startServer({ dbPath: parsed.options.db, port, host });
    const address = await url;
    console.log(`API 已启动: ${address}`);
    console.log("健康检查: GET /health；按 Ctrl+C 退出。");
    return;
  }

  const store = new PedigreeStore(parsed.options.db);
  try {
    if (command === "import") {
      if (!args[0]) throw new Error("请提供家谱 JSON 文件路径或 JSON 字符串。");
      const result = store.importPedigree(readInput(args[0]));
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (command === "report") {
      const report = store.getReport(Number(args[0]));
      if (!report) throw new Error("版本不存在。");
      printMatrix(report);
      return;
    }
    if (command === "relationship") {
      const [versionId, a, b] = [Number(args[0]), args[1], args[2]];
      const report = store.getReport(versionId);
      if (!report) throw new Error("版本不存在。");
      if (!a || !b || report.matrix[a]?.[b] === undefined) throw new Error("个体不存在。");
      const value = report.matrix[a][b];
      console.log(
        `A[${a},${b}]=${formatNumber(value)}；亲缘系数 A/2=${formatNumber(value / 2)}`,
      );
      return;
    }
    if (command === "inbreeding") {
      const report = store.getReport(Number(args[0]));
      const id = args[1];
      if (!report || !id) throw new Error("版本不存在。");
      if (!(id in report.inbreeding)) throw new Error("个体不存在。");
      console.log(
        `F[${id}]=${formatNumber(report.inbreeding[id])}；A[${id},${id}]=${formatNumber(report.matrix[id][id])}`,
      );
      return;
    }
    if (command === "cell") {
      const dependency = store.getCell(Number(args[0]), String(args[1]), String(args[2]));
      if (!dependency) throw new Error("矩阵单元不存在。");
      console.log(JSON.stringify(dependency, null, 2));
      return;
    }
    if (command === "export") {
      const report = store.getReport(Number(args[0]));
      if (!report) throw new Error("版本不存在。");
      const output = JSON.stringify(report, null, 2);
      if (args[1]) writeFileSync(args[1], output, "utf8");
      else process.stdout.write(output + "\n");
      return;
    }
    if (command === "compare") {
      const diff = store.compareVersions(Number(args[0]), Number(args[1]));
      if (!diff) throw new Error("参与比较的版本必须都存在。");
      console.log(JSON.stringify(diff, null, 2));
      return;
    }
    printHelp();
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  const payload =
    error instanceof Error && "code" in error
      ? { error: error.message, code: String((error as { code: unknown }).code) }
      : { error: error instanceof Error ? error.message : "命令执行失败", code: "CLI_ERROR" };
  console.error(JSON.stringify(payload, null, 2));
  process.exitCode = 1;
});
