# 家谱亲缘矩阵与近交系数计算后端

一个纯本地的演示服务：输入虚构个体编号及其两个亲本引用，输出分子亲缘关系矩阵 **A**、个体近交系数 **F** 与递推解释。仅用于演示家谱递推算法。

**边界声明**：本项目不采集真实身份证明、基因序列或健康资料，不做疾病预测、血缘鉴定或生活建议。所有输出均为双精度浮点近似值（容限 1e-9），不是遗传测量值。

## 核心概念（三个不同的量，不可混用）

- **A（分子亲缘关系矩阵）**：对角线 `A[i,i] = 1 + F[i]`，非近交个体为 1。
- **亲缘系数 = A / 2**：非近交个体自身为 0.5。
- **F（近交系数）**：`F[i] = A[亲本1, 亲本2] / 2`，两个亲本都已知时才可能非零。

递推规则（表格法）：将家谱排成亲本先于后代的顺序后，对更早的 j：

```
A[i,j] = 0.5 * A[亲本1, j] + 0.5 * A[亲本2, j]   （未知亲本项为 0）
A[i,i] = 1 + A[亲本1, 亲本2] / 2                  （双亲已知）
A[i,i] = 1                                        （至少一个亲本未知）
```

## 假设与局限

- 创始个体（无已知亲本者）之间**互不相关**且非近交。若实际创始者存在未知亲缘，本假设会低估后代的 F——这是表格法的固有局限。
- 未知亲本用空值（`null`、空串或省略）表示，每个未知亲本视为**独立的**未知来源，不会把所有空值当成同一个共同祖先。
- 亲本位置仅表示两个来源，不建立性别系统。
- 导入顺序不影响结果：同代个体按编号字典序确定稳定计算顺序。

## 快速开始（Windows 本地，Node.js ≥ 22，无需 Docker/WSL/外部服务）

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm start         # 启动 API（默认自动选择空闲端口；PORT=8080 可指定）
npm run demo      # 演示亲本更正造成后代数值变化并列出两版本差异
```

CLI 示例：

```powershell
node dist/src/cli.js import examples/classic.json
node dist/src/cli.js report 1
node dist/src/cli.js relationship 1 C D
node dist/src/cli.js inbreeding 1 E
node dist/src/cli.js cell 1 E P
node dist/src/cli.js matrix 1
node dist/src/cli.js compare 1 2
```

## 一个小例子

```json
{ "individuals": [
  { "id": "P" }, { "id": "Q" },
  { "id": "C", "parent1": "P", "parent2": "Q" },
  { "id": "D", "parent1": "P", "parent2": "Q" },
  { "id": "E", "parent1": "C", "parent2": "D" }
] }
```

按 P, Q, C, D, E 顺序，A 矩阵为：

```
      P     Q     C     D     E
P  [  1     0    0.5   0.5   0.5 ]
Q  [  0     1    0.5   0.5   0.5 ]
C  [ 0.5   0.5    1    0.5  0.75 ]
D  [ 0.5   0.5   0.5    1   0.75 ]
E  [ 0.5   0.5  0.75  0.75  1.25 ]
```

读法：C、D 是同亲本兄妹，`A[C,D]=0.5`（亲缘系数 0.25）；E 由 C×D 产生，`F[E]=A[C,D]/2=0.25`，`A[E,E]=1+F=1.25`。半同胞的 A 为 0.25，亲子为 0.5，独立创始者之间为 0。

## API（均为 JSON）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/versions` | 导入家谱，体为 `{individuals:[...]}`；校验+计算全部成功才落库 |
| GET | `/versions` | 列出所有版本 |
| GET | `/versions/:id/report` | 计算报告（顺序、F、亲缘系数、假设） |
| GET | `/versions/:id/relationship?a=X&b=Y` | 两人 A、A/2 等 |
| GET | `/versions/:id/inbreeding/:id` | 个体 F |
| GET | `/versions/:id/cell?i=X&j=Y` | 矩阵单元的递推依赖（直接亲本单元与加权结果） |
| GET | `/versions/:id/matrix` | 导出完整矩阵 |
| GET | `/compare?from=1&to=2` | 比较两个版本的 F 与矩阵差异 |

更正亲本关系时再次 POST `/versions` 生成新版本；旧版本仍按原输入可查。

## 错误码

`BAD_INPUT` / `BAD_JSON` / `BAD_ID` / `DUPLICATE_ID` / `SELF_PARENT` / `SAME_PARENTS` / `UNKNOWN_PARENT` / `PARENT_CYCLE` / `TOO_MANY_INDIVIDUALS` / `NOT_FOUND` / `VERSION_NOT_FOUND`。校验失败返回 400 且**不会**写入任何部分数据。

## 配置（环境变量）

- `PORT`：API 端口，缺省自动选择空闲端口
- `PEDIGREE_DATA_DIR`：数据目录（默认项目内 `data/`）
- `PEDIGREE_DB`：SQLite 文件路径
- `PEDIGREE_MAX_INDIVIDUALS`：个体数量上限（默认 2000）

## 存储

SQLite（Node 内置 `node:sqlite`，无原生依赖）保存：原始家谱边、假设文本、计算顺序、算法版本（`tabular-a-v1`）与完整矩阵。版本不可变，便于审计与回溯。
