# 家谱亲缘矩阵与近交系数计算后端

这是一个仅用于演示家谱数学递推的 Windows 本地后端，提供 TypeScript/Node.js HTTP API 与 CLI，使用 Node 内置 `node:sqlite` 保存版本化数据。不需要 Docker、WSL、付费服务或外部在线 API。

服务只处理虚构个体编号及两个亲本引用，不采集真实身份证明、基因序列或健康资料；不做疾病预测、血缘鉴定或生活建议。亲本位置只表示两个来源，不建立性别系统。

## 概念区别

- `A[i,j]`：分子亲缘关系矩阵（additive/numerator relationship matrix）。
- 亲缘系数：`A[i,j]/2`，展示时单独命名，不与 `A` 混用。
- `F[i] = A[i,i] - 1`：个体近交系数。

创始者 `P`、`Q` 互不相关：

```text
A[P,P]=1, A[Q,Q]=1, A[P,Q]=0
C 的亲本为 P、Q：A[C,P]=0.5, A[C,Q]=0.5
D 与 C 同亲本：A[C,D]=0.5，亲缘系数=0.25
E 的亲本为 C、D：F[E]=A[C,D]/2=0.25，A[E,E]=1.25
```

注意：这是基于用户所报亲本关系的数学模型。创始者互不相关、未知来源互不相关等都是简化假设；未知亲本可能携带的真实谱系信息没有被观测，因此结果不能宣称为遗传测量值。

## 假设与递推

1. 先做拓扑排序，保证亲本先于后代；同代按编号升序稳定计算。
2. 对个体 `i` 与更早的 `j`：

```text
A[i,j] = (A[parent1,j] + A[parent2,j]) / 2
```

未知亲本对应项为零。矩阵按对称填入。

3. 两个亲本都已知：

```text
F[i] = A[parent1,parent2] / 2
A[i,i] = 1 + F[i]
```

4. 至少一个亲本未知：按未知来源与现有家系互不相关处理，`F[i]=0`、`A[i,i]=1`。不同空值不是同一个共同祖先。
5. 使用 IEEE-754 双精度浮点；输出解释将绝对值小于 `1e-12` 的数归零。

空家谱会生成一个空报告和空顺序。只有创始者时，创始者对角线为 1、相互关系为 0。只有一个已知亲本时，与已知亲本的 `A=0.5`，对角线仍为 1。默认个体上限为 20000。

## 构建、测试与演示

需要 Node.js 22.5+（开发环境为 Node 25.5，用到内置 `node:sqlite`）。

```powershell
npm install
npm run build
npm test
npm run demo
```

启动 API（默认端口 `0`，由操作系统选择空闲端口；启动日志会打印实际地址）：

```powershell
npm start
# 固定端口与数据文件
node dist/src/main.js serve --port 8080 --host 127.0.0.1 --db data/local.sqlite
```

## CLI

```powershell
node dist/src/main.js import examples/pedigree-v1.json --db data/demo-cli.sqlite
node dist/src/main.js report 1 --db data/demo-cli.sqlite
node dist/src/main.js relationship 1 C D --db data/demo-cli.sqlite
node dist/src/main.js inbreeding 1 E --db data/demo-cli.sqlite
node dist/src/main.js cell 1 E E --db data/demo-cli.sqlite
node dist/src/main.js export 1 report.json --db data/demo-cli.sqlite
node dist/src/main.js import examples/pedigree-v2-corrected.json --db data/demo-cli.sqlite
node dist/src/main.js compare 1 2 --db data/demo-cli.sqlite
```

## HTTP API

所有请求和响应均为 JSON，仅监听本机 `127.0.0.1`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `POST` | `/versions` | 校验并导入一个新版本 |
| `GET` | `/versions` | 列出版本 |
| `GET` | `/versions/{id}/report` | 原始家谱、假设、顺序、矩阵和 F |
| `GET` | `/versions/{id}/relationship?a=C&b=D` | 查询 `A` 与 `A/2` |
| `GET` | `/versions/{id}/inbreeding/{individualId}` | 查询 F 与对角线 |
| `GET` | `/versions/{id}/cell/{row}/{col}` | 查询直接亲本单元与加权解释 |
| `GET` | `/versions/{from}/compare/{to}` | 比较两个版本 |

导入示例：

```json
{
  "algorithmVersion": "additive-relationship-recursive-v1",
  "note": "可选说明",
  "individuals": [
    { "id": "P", "parent1": null, "parent2": null },
    { "id": "Q" },
    { "id": "C", "parent1": "P", "parent2": "Q" }
  ]
}
```

## 错误码

- `INVALID_JSON` / `INVALID_INDIVIDUALS` / `INVALID_INDIVIDUAL` / `INVALID_ID` / `INVALID_PARENT`
- `DUPLICATE_ID` / `DUPLICATE_PARENT` / `SELF_PARENT`
- `MISSING_PARENT_REFERENCE` / `PARENT_CYCLE`
- `TOO_MANY_INDIVIDUALS` / `UNSUPPORTED_ALGORITHM_VERSION`
- `VERSION_NOT_FOUND` / `INDIVIDUAL_NOT_FOUND` / `CELL_NOT_FOUND`
- `PAYLOAD_TOO_LARGE`（导入 JSON 最大 10 MB）

所有校验先完整完成，然后在一个 SQLite 事务中写入版本、顺序、矩阵、F 和依赖解释。环或坏引用失败时不会留下半张家谱。亲本更正始终创建新版本；旧版本仍按当时输入查询和导出。

## 版本更正示例

`examples/pedigree-v1.json` 中 C、D 是全同胞，`A[C,D]=0.5`，所以 E 的 `F[E]=0.25`、`A[E,E]=1.25`。

`examples/pedigree-v2-corrected.json` 将 D 的第二来源更正为独立创始者 R，C、D 成为半同胞，`A[C,D]=0.25`，因此 E 的 `F[E]=0.125`、`A[E,E]=1.125`。`compare` 会列出新增/删除个体、F 差异以及所有变化的矩阵单元。

## 限制

- 仅做后端 API/CLI，没有网页界面、鉴权或多用户权限模型。
- 默认只绑定本机回环地址；矩阵规模约为个体数平方，上限可在 `src/pedigree.ts` 调整。
- 不推断未知亲本身份，不从外部数据补谱，也不解释为真实生物测量。
