import { useState } from 'react';
import { PageEditor } from '../features/pages/pagebuilder';
import { PagesList } from '../features/pages/pages-list';
import { useMerchant, useStoreData } from '../common/store-context';

export function PagesPage() {
  const { api, store } = useMerchant();
  const { me } = useStoreData();
  const [editing, setEditing] = useState<{ path: string; isNew: boolean; title?: string } | null>(
    null
  );
  if (editing)
    return (
      <PageEditor
        api={api}
        store={store}
        path={editing.path}
        isNew={editing.isNew}
        isLocal={!!me?.isLocal}
        initialTitle={editing.title}
        onBack={() => setEditing(null)}
      />
    );
  return (
    <PagesList
      api={api}
      store={store}
      onOpen={(path, isNew, title) => setEditing({ path, isNew, title })}
    />
  );
}
