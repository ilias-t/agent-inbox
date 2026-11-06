// Types for shared/mint-sql.mjs (see there).
export interface MintValues {
  id: string;
  name: string;
  scope: string;
  orchestrator: string;
  hash: string;
  now: string;
  by: string;
  fleet: string;
}
export interface MintOutcome {
  inserted: number | boolean;
  name_taken: number | boolean;
  owner: string | null;
  fleet: string;
  fleet_known: number | boolean;
}
export function mintTokenSql(v: MintValues, opts?: { createFleet?: boolean }): string;
export function mintFleetDocSql(v: MintValues): string;
export function mintOutcomeSql(v: MintValues): string;
export function mintRefusal(row: MintOutcome, args: { name: string; orchestrator?: string | null }): { status: 400 | 409; message: string };
