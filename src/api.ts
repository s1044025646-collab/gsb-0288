import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";
import { Store } from "./db.js";
import { PedigreeError, DEFAULT_MAX_INDIVIDUALS } from "./pedigree.js";
import * as svc from "./service.js";

const DATA_DIR = process.env.PEDIGREE_DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.PEDIGREE_DB ?? path.join(DATA_DIR, "pedigree.db");
const MAX_INDIVIDUALS = Number(process.env.PEDIGREE_MAX_INDIVIDUALS ?? DEFAULT_MAX_INDIVIDUALS);

export function findFreePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(preferred, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new PedigreeError("BAD_JSON", "请求体不是合法 JSON"); }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const vid = parts[0] === "versions" && parts[1] !== undefined ? Number(parts[1]) : NaN;

      if (method === "POST" && url.pathname === "/versions") {
        const body = (await readBody(req)) as { individuals?: unknown };
        if (!Array.isArray(body.individuals))
          throw new PedigreeError("BAD_INPUT", "请求体需为 { individuals: [{id, parent1, parent2}, ...] }");
        const { versionId, result } = store.importVersion(body.individuals as never[], MAX_INDIVIDUALS);
        return send(res, 201, { versionId, individualCount: result.order.length, order: result.order });
      }
      if (method === "GET" && url.pathname === "/versions") return send(res, 200, store.listVersions());
      if (method === "GET" && parts[0] === "compare") {
        const from = Number(url.searchParams.get("from"));
        const to = Number(url.searchParams.get("to"));
        if (!Number.isInteger(from) || !Number.isInteger(to))
          throw new PedigreeError("BAD_INPUT", "compare 需要整数参数 from 与 to");
        return send(res, 200, svc.compareVersions(store, from, to));
      }
      if (parts[0] === "versions" && Number.isInteger(vid)) {
        const sub = parts[2];
        if (method === "GET" && sub === "report") return send(res, 200, svc.report(store, vid));
        if (method === "GET" && sub === "relationship") {
          const a = url.searchParams.get("a"); const b = url.searchParams.get("b");
          if (!a || !b) throw new PedigreeError("BAD_INPUT", "relationship 需要参数 a 与 b");
          return send(res, 200, svc.relationship(store, vid, a, b));
        }
        if (method === "GET" && sub === "inbreeding" && parts[3])
          return send(res, 200, svc.inbreeding(store, vid, decodeURIComponent(parts[3])));
        if (method === "GET" && sub === "cell") {
          const i = url.searchParams.get("i"); const j = url.searchParams.get("j");
          if (!i || !j) throw new PedigreeError("BAD_INPUT", "cell 需要参数 i 与 j");
          return send(res, 200, svc.cell(store, vid, i, j));
        }
        if (method === "GET" && sub === "matrix") return send(res, 200, svc.exportMatrix(store, vid));
      }
      return send(res, 404, { error: { code: "NOT_FOUND", message: "未知路由" } });
    } catch (e) {
      if (e instanceof PedigreeError) return send(res, 400, { error: { code: e.code, message: e.message } });
      return send(res, 500, { error: { code: "INTERNAL", message: String(e) } });
    }
  });
}

export async function startServer(): Promise<{ server: http.Server; port: number }> {
  const store = new Store(DB_PATH);
  const server = createServer(store);
  const preferred = process.env.PORT ? Number(process.env.PORT) : 0; // 默认 0 = 自动选择空闲端口
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(preferred, () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : preferred);
    });
    server.on("error", reject);
  });
  return { server, port };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const { port } = await startServer();
  console.log(`家谱亲缘矩阵服务已启动: http://localhost:${port}  (数据库: ${DB_PATH})`);
}
