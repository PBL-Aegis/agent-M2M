import type { BenchmarkSnapshot, Catalog } from "./types";

export const AA_URL: string;
export const EPOCH_ECI_URL: string;
export const OPENROUTER_URL: string;
export const MIN_ECI: number;

export type EpochRow = Record<string, string>;
export type SourceModel = Record<string, unknown>;

export function normalizeName(name: string): string;
export function perMillion(perToken: unknown): string | null;
export function parseCsv(text: string): Record<string, string>[];
export function fetchAa(key: string): Promise<SourceModel[]>;
export function fetchEpoch(): Promise<EpochRow[]>;
export function fetchOpenRouter(): Promise<SourceModel[]>;
export function buildCatalog(
  epochRows: EpochRow[],
  openRouterModels: SourceModel[],
  aaModels: SourceModel[],
  recipientOf: (providerId: string) => string,
  now?: Date,
): Catalog;
export function buildSnapshot(
  catalog: Catalog,
  epochRows: EpochRow[],
  openRouterModels: SourceModel[],
  aaModels: SourceModel[],
  now?: Date,
): BenchmarkSnapshot;
