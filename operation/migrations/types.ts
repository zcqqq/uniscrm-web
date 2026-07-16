import type { TenantDataDB } from "../../shared/tenant-data-db.ts";

export interface TenantMigration {
  name: string;
  apply(tdb: TenantDataDB): Promise<void>;
}
