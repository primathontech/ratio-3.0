import { Store } from '../../common/api';
import { SuperAdmin } from '../admin/superadmin';

export function AllStores({
  stores,
  isLocal,
  onCreate,
}: {
  stores: Store[];
  isLocal: boolean;
  onCreate: () => void;
}) {
  return <SuperAdmin stores={stores} isLocal={isLocal} onCreate={onCreate} />;
}
