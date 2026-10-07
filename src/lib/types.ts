/** Shared API types for the PostgreSQL console. */

export interface ApiErrorPayload {
  type: string;
  message: string;
  sqlstate?: string;
  detail?: string;
  hint?: string;
  position?: string;
  constraint?: string;
  table?: string;
  schema?: string;
  column?: string;
  statementIndex?: number;
}

export interface Envelope<T> {
  ok: boolean;
  data: T | null;
  error: ApiErrorPayload | null;
}

export interface SchemaInfo {
  name: string;
  internal: boolean;
  owner: string;
  tableCount: number;
}

export interface SchemasData {
  database: string;
  user: string;
  serverVersion: string;
  schemas: SchemaInfo[];
}

export interface TableInfo {
  name: string;
  schema: string;
  kind: string;
  estimatedRows: number | null;
  sizeBytes: number | null;
  owner: string;
}

export interface TablesData {
  schema: string;
  tables: TableInfo[];
}

export interface ColumnInfo {
  name: string;
  position: number;
  type: string;
  nullable: boolean;
  default: string | null;
  identity: string | null;
  generated: string | null;
  collation: string | null;
  comment: string | null;
}

export interface IndexInfo {
  name: string;
  method: string;
  unique: boolean;
  primary: boolean;
  valid: boolean;
  columns: string[];
  definition: string;
  constraintName: string | null;
}

export interface ConstraintInfo {
  name: string;
  kind: string;
  kindLabel: string;
  definition: string;
  validated: boolean;
  columns: string[];
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
  definition: string;
}

export interface TableMeta {
  schema: string;
  name: string;
  kind: string;
  owner: string;
  estimatedRows: number | null;
  sizeBytes: number | null;
  persistence: string;
  comment: string | null;
  partitionKey: string | null;
}

export interface TableDetailsData {
  table: TableMeta;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  constraints: ConstraintInfo[];
  foreignKeys: ForeignKeyInfo[];
  primaryKey: { columns: string[] };
  ddl: string;
}

export interface QueryColumn {
  name: string;
  type: string;
}

export type QueryValue = string | number | boolean | null | QueryValue[] | { [key: string]: QueryValue };
export type QueryRow = Record<string, QueryValue>;

export interface StatementSummary {
  index: number;
  command: string;
  rowCount: number;
  durationMs: number;
  hasRows: boolean;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: QueryRow[];
  rowCount: number;
  command: string;
  durationMs: number;
  messages: string[];
  statements: StatementSummary[];
  truncated: boolean;
}

export interface TableDataData {
  schema: string;
  table: string;
  mode: "keyset" | "offset";
  limit: number;
  offset: number | null;
  orderedBy: string[];
  primaryKey: string[];
  columns: QueryColumn[];
  rows: QueryRow[];
  rowCount: number;
  hasMore: boolean;
  nextCursor: QueryValue[] | null;
}