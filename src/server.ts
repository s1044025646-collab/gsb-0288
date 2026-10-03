import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { PedigreeStore } from "./store.js";
import { PedigreeValidationError } from "./pedigree.js";
import type { PedigreeInput } from "./types.js";

export interface ServerOptions {
  dbPath: string;
  port?: number;
  host?: string;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 10 * 1024 * 1024) {
      throw new PedigreeValidationError("PAYLOAD_TOO_LARGE", "请求体不能超过 10 MB。");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  } catch {
    throw new PedigreeValidationError("INVALID_JSON", "请求体必须是合法 JSON。");
  }
}

export function resolveDbPath(path: string | undefined): string {
  if (!path) return join(process.cwd(), "data", "pedigree.sqlite");
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

export function startServer(options: ServerOptions): {
  server: Server;
  store: PedigreeStore;
  url: Promise<string>;
} {
  const store = new PedigreeStore(options.dbPath);
  const server = createServer((request, response) => {
    void handle(request, response, store).catch((error: unknown) => {
      if (error instanceof PedigreeValidationError) {
        sendJson(response, 400, {
          error: error.message,
          code: error.code,
          details: error.details,
        });
      } else {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "未知服务器错误。",
          code: "INTERNAL_ERROR",
        });
      }
    });
  });

  const url = new Promise<string>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolvePromise(`http://${options.host ?? "127.0.0.1"}:${address.port}`);
    });
  });
  return { server, store, url };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  store: PedigreeStore,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const method = request.method ?? "GET";
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (method === "GET" && path === "/health") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (method === "GET" && path === "/versions") {
    sendJson(response, 200, { versions: store.listVersions() });
    return;
  }
  if (method === "POST" && path === "/versions") {
    const body = (await readJson(request)) as PedigreeInput;
    sendJson(response, 201, { version: store.importPedigree(body) });
    return;
  }

  const reportMatch = /^\/versions\/(\d+)\/report$/.exec(path);
  if (method === "GET" && reportMatch) {
    const report = store.getReport(Number(reportMatch[1]));
    if (!report) return sendNotFound(response, "VERSION_NOT_FOUND", "版本不存在。");
    sendJson(response, 200, { report });
    return;
  }

  const relationshipMatch = /^\/versions\/(\d+)\/relationship$/.exec(path);
  if (method === "GET" && relationshipMatch) {
    const versionId = Number(relationshipMatch[1]);
    const a = url.searchParams.get("a");
    const b = url.searchParams.get("b");
    if (!a || !b) {
      throw new PedigreeValidationError(
        "MISSING_QUERY_PARAMETER",
        "查询参数 a 和 b 均为必填。",
      );
    }
    const report = store.getReport(versionId);
    if (!report) return sendNotFound(response, "VERSION_NOT_FOUND", "版本不存在。");
    const value = report.matrix[a]?.[b];
    if (value === undefined) {
      return sendNotFound(response, "INDIVIDUAL_NOT_FOUND", "矩阵中找不到指定个体。");
    }
    sendJson(response, 200, {
      versionId,
      a,
      b,
      additiveRelationship: value,
      kinshipCoefficient: value / 2,
      note: "A 是分子亲缘关系矩阵；亲缘系数为 A/2。二者不可换名。",
    });
    return;
  }

  const inbreedingMatch = /^\/versions\/(\d+)\/inbreeding\/([^/]+)$/.exec(path);
  if (method === "GET" && inbreedingMatch) {
    const versionId = Number(inbreedingMatch[1]);
    const id = decodeURIComponent(inbreedingMatch[2]);
    const report = store.getReport(versionId);
    if (!report) return sendNotFound(response, "VERSION_NOT_FOUND", "版本不存在。");
    if (!(id in report.inbreeding)) {
      return sendNotFound(response, "INDIVIDUAL_NOT_FOUND", "个体不存在。");
    }
    sendJson(response, 200, {
      versionId,
      id,
      inbreedingCoefficient: report.inbreeding[id],
      additiveDiagonal: report.matrix[id][id],
      note: "F[i]=A[i,i]-1；双亲已知时也等于 A[parent1,parent2]/2。",
    });
    return;
  }

  const cellMatch = /^\/versions\/(\d+)\/cell\/([^/]+)\/([^/]+)$/.exec(path);
  if (method === "GET" && cellMatch) {
    const versionId = Number(cellMatch[1]);
    const row = decodeURIComponent(cellMatch[2]);
    const col = decodeURIComponent(cellMatch[3]);
    const dependency = store.getCell(versionId, row, col);
    if (!dependency) return sendNotFound(response, "CELL_NOT_FOUND", "版本或矩阵单元不存在。");
    sendJson(response, 200, { dependency });
    return;
  }

  const compareMatch = /^\/versions\/(\d+)\/compare\/(\d+)$/.exec(path);
  if (method === "GET" && compareMatch) {
    const diff = store.compareVersions(
      Number(compareMatch[1]),
      Number(compareMatch[2]),
    );
    if (!diff) return sendNotFound(response, "VERSION_NOT_FOUND", "参与比较的版本必须都存在。");
    sendJson(response, 200, { comparison: diff });
    return;
  }

  sendNotFound(response, "ROUTE_NOT_FOUND", "未找到 API 路由。");
}

function sendNotFound(response: ServerResponse, code: string, error: string): void {
  sendJson(response, 404, { error, code });
}
