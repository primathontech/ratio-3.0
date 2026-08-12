// The theme store (LLD BC1/BC2): theme file BYTES live as compressed bundles in an ObjectStore (S3),
// never one object per file. The mutable draft is one source bundle; Publish freezes an immutable,
// content-addressed source bundle (for merges / re-editing) plus a compiled bundle (for rendering).
// Postgres metadata — the file index, version rows, and the live pointer — is layered on separately
// (a following slice); this class owns only the object-store side.
import { packBundle, unpackBundle, bundleId, type ThemeFiles } from './bundle';
import type { ObjectStore } from '@ratio/data-objects';

export interface ThemeRef {
  themeId: string;
}

// Compile a source tree into the render-ready tree (flatten base+overrides, precompile templates,
// resolve asset URLs). Injected so the store stays independent of the Liquid engine — the app wires
// the real compiler; tests can pass a trivial one.
export type CompileFn = (source: ThemeFiles) => ThemeFiles | Promise<ThemeFiles>;

export interface PublishedBundles {
  sourceHash: string; // content address of the frozen source bundle
  compiledHash: string; // content address of the compiled (render-ready) bundle
}

const GZIP = 'application/gzip';
const draftKey = (themeId: string) => `themes/${themeId}/draft/source.gz`;
const sourceKey = (hash: string) => `versions/source/${hash}.gz`;
const compiledKey = (hash: string) => `versions/compiled/${hash}.gz`;

export class ThemeStore {
  constructor(private readonly objects: ObjectStore) {}

  // Read the editable draft's source files (empty theme if never written).
  async readDraft(ref: ThemeRef): Promise<ThemeFiles> {
    const blob = await this.objects.get(draftKey(ref.themeId));
    return blob ? unpackBundle(Buffer.from(blob)) : {};
  }

  // Write the whole editable draft as one source bundle; returns its content hash.
  async saveDraft(ref: ThemeRef, files: ThemeFiles): Promise<{ hash: string }> {
    await this.objects.put(draftKey(ref.themeId), packBundle(files), { contentType: GZIP });
    return { hash: bundleId(files) };
  }

  // Freeze the current draft into immutable, content-addressed source + compiled bundles. The caller
  // records the returned hashes in a version row and flips the live pointer (Postgres, next slice).
  async publish(ref: ThemeRef, opts: { compile: CompileFn }): Promise<PublishedBundles> {
    const source = await this.readDraft(ref);
    const sourceHash = bundleId(source);
    await this.objects.put(sourceKey(sourceHash), packBundle(source), { contentType: GZIP });

    const compiled = await opts.compile(source);
    const compiledHash = bundleId(compiled);
    await this.objects.put(compiledKey(compiledHash), packBundle(compiled), { contentType: GZIP });

    return { sourceHash, compiledHash };
  }

  // Load a compiled bundle by its content hash (what the origin renders), or null if absent.
  async loadCompiled(compiledHash: string): Promise<ThemeFiles | null> {
    const blob = await this.objects.get(compiledKey(compiledHash));
    return blob ? unpackBundle(Buffer.from(blob)) : null;
  }

  // Load a source bundle by its content hash (for merges / re-editing an old version), or null.
  async loadSource(sourceHash: string): Promise<ThemeFiles | null> {
    const blob = await this.objects.get(sourceKey(sourceHash));
    return blob ? unpackBundle(Buffer.from(blob)) : null;
  }
}
