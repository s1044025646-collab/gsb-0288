import type {
  CellDependency,
  ComputationResult,
  IndividualInput,
  ValidatedIndividual,
} from "./types.js";

export const ALGORITHM_VERSION = "additive-relationship-recursive-v1";
export const MAX_INDIVIDUALS = 20000;
export const EPSILON = 1e-12;

export class PedigreeValidationError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "PedigreeValidationError";
  }
}

function normalizeParent(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new PedigreeValidationError(
      "INVALID_PARENT",
      "亲本编号必须为字符串、空值或缺省。",
      { received: String(value) },
    );
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function validatePedigree(input: {
  individuals?: unknown;
}): ValidatedIndividual[] {
  if (!Array.isArray(input.individuals)) {
    throw new PedigreeValidationError(
      "INVALID_INDIVIDUALS",
      "individuals 必须是数组。",
    );
  }
  if (input.individuals.length > MAX_INDIVIDUALS) {
    throw new PedigreeValidationError(
      "TOO_MANY_INDIVIDUALS",
      `个体数量不能超过 ${MAX_INDIVIDUALS}。`,
      { count: input.individuals.length, limit: MAX_INDIVIDUALS },
    );
  }

  const people: ValidatedIndividual[] = [];
  const seen = new Set<string>();

  for (const raw of input.individuals) {
    if (typeof raw !== "object" || raw === null) {
      throw new PedigreeValidationError(
        "INVALID_INDIVIDUAL",
        "每个个体必须是对象。",
      );
    }
    const item = raw as IndividualInput;
    if (typeof item.id !== "string") {
      throw new PedigreeValidationError(
        "INVALID_ID",
        "个体 id 必须是非空字符串。",
      );
    }
    const id = item.id.trim();
    if (id.length === 0 || id.length > 100) {
      throw new PedigreeValidationError(
        "INVALID_ID",
        "个体 id 必须为 1 至 100 个字符。",
      );
    }
    if (seen.has(id)) {
      throw new PedigreeValidationError(
        "DUPLICATE_ID",
        "检测到重复个体编号。",
        { id },
      );
    }
    const parent1 = normalizeParent(item.parent1);
    const parent2 = normalizeParent(item.parent2);
    if (parent1 !== null && parent1 === id) {
      throw new PedigreeValidationError(
        "SELF_PARENT",
        "个体不能作为自身的亲本。",
        { id, parent: id },
      );
    }
    if (parent2 !== null && parent2 === id) {
      throw new PedigreeValidationError(
        "SELF_PARENT",
        "个体不能作为自身的亲本。",
        { id, parent: id },
      );
    }
    if (parent1 !== null && parent1 === parent2) {
      throw new PedigreeValidationError(
        "DUPLICATE_PARENT",
        "两个亲本位置不能引用同一个编号。",
        { id, parent: parent1 },
      );
    }
    seen.add(id);
    people.push({ id, parent1, parent2 });
  }

  for (const person of people) {
    for (const parent of [person.parent1, person.parent2]) {
      if (parent !== null && !seen.has(parent)) {
        throw new PedigreeValidationError(
          "MISSING_PARENT_REFERENCE",
          "存在指向不存在个体的非空亲本引用。",
          { id: person.id, parent },
        );
      }
    }
  }

  const order = topologicalOrder(people);
  void order;
  return people;
}

export function topologicalOrder(people: ValidatedIndividual[]): string[] {
  const byId = new Map(people.map((person) => [person.id, person]));
  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const order: string[] = [];

  const visit = (id: string, trail: string[]): void => {
    if (permanent.has(id)) return;
    if (temporary.has(id)) {
      throw new PedigreeValidationError(
        "PARENT_CYCLE",
        "家谱存在亲本环，无法排成亲本先于后代的顺序。",
        { cycle: [...trail, id] },
      );
    }
    temporary.add(id);
    const person = byId.get(id);
    if (person) {
      const parents = [person.parent1, person.parent2]
        .filter((parent): parent is string => parent !== null)
        .sort();
      for (const parent of parents) visit(parent, [...trail, id]);
    }
    temporary.delete(id);
    permanent.add(id);
    order.push(id);
  };

  for (const id of [...byId.keys()].sort()) visit(id, []);
  return order;
}

function key(a: string, b: string): string {
  return a <= b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function orderedPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

export function computeRelationshipMatrix(
  people: ValidatedIndividual[],
): ComputationResult {
  const byId = new Map(people.map((person) => [person.id, person]));
  const order = topologicalOrder(people);
  const values = new Map<string, number>();
  const dependencyMap: Record<string, CellDependency> = {};
  const matrix: Record<string, Record<string, number>> = {};
  const inbreeding: Record<string, number> = {};

  const get = (a: string, b: string): number => {
    const [x, y] = orderedPair(a, b);
    const existing = values.get(key(x, y));
    if (existing === undefined) {
      throw new Error(`内部错误：尚未计算单元 ${x},${y}`);
    }
    return existing;
  };

  const set = (a: string, b: string, value: number): void => {
    const [x, y] = orderedPair(a, b);
    values.set(key(x, y), value);
    if (!matrix[x]) matrix[x] = {};
    matrix[x][y] = value;
    if (x !== y) {
      if (!matrix[y]) matrix[y] = {};
      matrix[y][x] = value;
    }
  };

  for (const id of order) {
    const person = byId.get(id);
    if (!person) throw new Error("内部错误：个体不存在。");
    matrix[id] ??= {};

    const knownParents = [person.parent1, person.parent2].filter(
      (parent): parent is string => parent !== null,
    );

    for (const earlierId of order) {
      if (earlierId === id) break;
      const terms = knownParents.map((parent) => ({
        parent,
        other: earlierId,
        value: get(parent, earlierId) / 2,
      }));
      const value = terms.reduce((sum, term) => sum + term.value, 0);
      set(id, earlierId, value);

      const cellName = `A[${id},${earlierId}]`;
      const formulaParts = knownParents.map(
        (parent) => `A[${parent},${earlierId}]/2`,
      );
      dependencyMap[key(id, earlierId)] = {
        row: id,
        col: earlierId,
        value,
        diagonal: false,
        formula:
          formulaParts.length > 0 ? formulaParts.join(" + ") : "0（无更早关系项）",
        directParentCells: terms.map((term) => ({
          cell: `A[${term.parent},${term.other}]`,
          parent: term.parent,
          other: term.other,
          value: term.value * 2,
          weight: 0.5,
        })),
        explanation:
          knownParents.length === 0
            ? `${cellName}=0：${id} 是创始个体，按与其他创始者互不相关处理。`
            : `${cellName}=${formatNumber(value)}；直接取两个已知亲本位置对 ${earlierId} 的关系并各乘 0.5，未知亲本位置贡献为 0。`,
      };
    }

    let diagonal: number;
    let inbreedingValue: number;
    const dep: CellDependency = {
      row: id,
      col: id,
      value: 0,
      diagonal: true,
      formula: "",
      directParentCells: [],
      explanation: "",
    };

    if (person.parent1 !== null && person.parent2 !== null) {
      const parentRelationship = get(person.parent1, person.parent2);
      inbreedingValue = parentRelationship / 2;
      diagonal = 1 + inbreedingValue;
      dep.formula = `1 + A[${person.parent1},${person.parent2}]/2`;
      dep.coancestryTerm = {
        cell: `A[${person.parent1},${person.parent2}]`,
        parent1: person.parent1,
        parent2: person.parent2,
        value: parentRelationship,
        weight: 0.5,
      };
      dep.explanation = `A[${id},${id}]=1+F[${id}]=${formatNumber(diagonal)}；F[${id}]=A[${person.parent1},${person.parent2}]/2=${formatNumber(inbreedingValue)}。`;
    } else {
      inbreedingValue = 0;
      diagonal = 1;
      const known = [person.parent1, person.parent2].filter(
        (value2): value2 is string => value2 !== null,
      );
      dep.formula = "1";
      dep.explanation =
        known.length === 0
          ? `A[${id},${id}]=1，F[${id}]=0：${id} 是创始个体，按创始者互不相关处理。`
          : `A[${id},${id}]=1，F[${id}]=0：至少一个亲本来源未知，按未知来源与所有家系互不相关处理。`;
    }

    dep.value = diagonal;
    set(id, id, diagonal);
    inbreeding[id] = inbreedingValue;
    dependencyMap[key(id, id)] = dep;
  }

  for (const id of order) matrix[id] ??= {};
  return { order, matrix, inbreeding, dependencies: dependencyMap };
}

export function formatNumber(value: number): string {
  if (Math.abs(value) < EPSILON) value = 0;
  return Number(value.toFixed(12)).toString();
}
