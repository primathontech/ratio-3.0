// Ops: hard-delete one or more stores by tenant id (atomic purge + zero-residual proof).
// Usage: DATABASE_URL=... npx tsx scripts/delete-store.ts <id> [<id> ...]
import { deleteStore } from '../packages/provisioning/index';
import { pool } from '../packages/shared/db';

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('usage: delete-store <tenantId> [<tenantId> ...]');
  process.exit(1);
}

(async () => {
  for (const id of ids) {
    const proof = await deleteStore(id);
    console.log(id, JSON.stringify(proof));
  }
  await pool.end();
})().catch((e: unknown) => {
  console.error('delete failed:', (e as Error).message);
  process.exit(1);
});
