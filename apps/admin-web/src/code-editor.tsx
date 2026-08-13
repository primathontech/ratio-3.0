import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { useTheme } from './theme';
import { Spinner } from './ui';

// Self-host Monaco: hand @monaco-editor/react the locally-bundled monaco instead of letting it fetch
// from a CDN (which fails behind a firewall/offline and is a runtime dependency we don't want). Run
// worker-less — syntax highlighting + editing run on the main thread (all a basic file editor needs);
// hand Monaco an empty worker so it never tries to fetch one. Configured once at module load.
loader.config({ monaco });
type MonacoGlobal = typeof globalThis & { MonacoEnvironment?: monaco.Environment };
(globalThis as MonacoGlobal).MonacoEnvironment = {
  getWorker: () => {
    const url = URL.createObjectURL(
      new Blob(['self.onmessage=()=>{}'], { type: 'text/javascript' })
    );
    const worker = new Worker(url);
    URL.revokeObjectURL(url); // the worker has loaded the script; free the blob URL
    return worker;
  },
};

// Monaco language by file extension. Liquid has no built-in mode; HTML is the closest fit (it keeps
// the {{ }} / {% %} as text) and is the right default for templates.
function languageFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'css') return 'css';
  if (ext === 'json') return 'json';
  if (ext === 'js' || ext === 'mjs') return 'javascript';
  if (ext === 'ts') return 'typescript';
  return 'html';
}

// A Monaco (VS Code) editor for theme files. The `path` prop gives each file its own model, so
// switching files preserves per-file cursor/undo; `defaultValue` seeds a model once (uncontrolled —
// edits flow up through onChange, props never clobber the buffer).
export function CodeEditor({
  path,
  initialValue,
  onChange,
}: {
  path: string;
  initialValue: string;
  onChange: (value: string) => void;
}) {
  const { resolved } = useTheme();
  return (
    <div className="code-host">
      <Editor
        path={path}
        defaultValue={initialValue}
        language={languageFor(path)}
        theme={resolved === 'dark' ? 'vs-dark' : 'light'}
        onChange={(v) => onChange(v ?? '')}
        loading={<Spinner />}
        options={{
          minimap: { enabled: false },
          fontSize: 13,
          tabSize: 2,
          scrollBeyondLastLine: false,
          automaticLayout: true,
          renderLineHighlight: 'all',
        }}
      />
    </div>
  );
}
