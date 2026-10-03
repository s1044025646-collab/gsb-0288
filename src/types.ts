export interface PedigreeInput {
  algorithmVersion: string;
  note?: string;
  individuals: IndividualInput[];
}

export interface IndividualInput {
  id: string;
  parent1?: string | null;
  parent2?: string | null;
}

export interface ValidatedIndividual {
  id: string;
  parent1: string | null;
  parent2: string | null;
}

export interface ComputedCell {
  row: string;
  col: string;
  value: number;
}

export interface CellDependency {
  row: string;
  col: string;
  value: number;
  diagonal: boolean;
  formula: string;
  directParentCells: Array<{
    cell: string;
    parent: string;
    other: string;
    value: number;
    weight: number;
  }>;
  coancestryTerm?: {
    cell: string;
    parent1: string;
    parent2: string;
    value: number;
    weight: number;
  };
  explanation: string;
}

export interface ComputationResult {
  order: string[];
  matrix: Record<string, Record<string, number>>;
  inbreeding: Record<string, number>;
  dependencies: Record<string, CellDependency>;
}

export interface ServiceError {
  error: string;
  code: string;
  details?: unknown;
}
