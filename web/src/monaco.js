// web/src/monaco.js
// Monaco, VS Code's editor, set up for px0: its web worker served from
// static/dist/, the px0 theme mapped onto it (theme.js), and a few file names
// Monaco does not recognise by extension.
import * as monaco from './gen/monaco.js';
import { on } from './util.js';
import { monacoTheme } from './theme.js';

self.MonacoEnvironment = {
  getWorker: () => new Worker(new URL('static/dist/editor.worker.js', document.baseURI), { name: 'monaco-editor', type: 'module' }),
};

const THEME = 'px0';

/* JSON: Monaco's JSON support comes with its language service, which px0
   leaves out (see scripts/gen-monaco.js), so give it a Monarch highlighter. */
if (!monaco.languages.getLanguages().some(l => l.id === 'json')) {
  monaco.languages.register({ id: 'json', extensions: ['.json', '.jsonc', '.json5', '.code-workspace', '.babelrc', '.eslintrc'], filenames: ['.prettierrc'], aliases: ['JSON', 'json'], mimetypes: ['application/json'] });
}
monaco.languages.setMonarchTokensProvider('json', {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key'],
      [/"(?:[^"\\]|\\.)*"/, 'string.value'],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      [/\b(?:true|false|null)\b/, 'keyword'],
      [/\/\/.*$/, 'comment'],
      [/\/\*/, 'comment', '@comment'],
      [/[{}[\]]/, 'delimiter.bracket'],
      [/[,:]/, 'delimiter'],
    ],
    comment: [[/[^/*]+/, 'comment'], [/\*\//, 'comment', '@pop'], [/[/*]/, 'comment']],
  },
});
monaco.languages.setLanguageConfiguration('json', {
  comments: { lineComment: '//', blockComment: ['/*', '*/'] },
  brackets: [['{', '}'], ['[', ']']],
  autoClosingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"', notIn: ['string'] }],
  surroundingPairs: [{ open: '{', close: '}' }, { open: '[', close: ']' }, { open: '"', close: '"' }],
});

export function applyMonacoTheme() {
  monaco.editor.defineTheme(THEME, monacoTheme());
  monaco.editor.setTheme(THEME);
}

on('theme:changed', applyMonacoTheme);

// File names (not extensions) Monaco has no language for on its own.
const BY_NAME = {
  'makefile': 'shell', 'gnumakefile': 'shell', 'justfile': 'shell', '.bashrc': 'shell', '.zshrc': 'shell',
  '.profile': 'shell', '.env': 'shell', 'go.mod': 'go', 'go.work': 'go', 'cmakelists.txt': 'shell',
  'jenkinsfile': 'groovy', 'vagrantfile': 'ruby', 'gemfile': 'ruby', 'rakefile': 'ruby', 'podfile': 'ruby',
  '.gitignore': 'shell', '.dockerignore': 'shell', '.editorconfig': 'ini', '.npmrc': 'ini',
};
const BY_EXT = {
  mjs: 'javascript', cjs: 'javascript', jsonc: 'json', json5: 'json', tsx: 'typescript', jsx: 'javascript',
  mts: 'typescript', cts: 'typescript', svelte: 'html', vue: 'html', toml: 'ini', conf: 'ini', cfg: 'ini',
  properties: 'ini', zsh: 'shell', bash: 'shell', fish: 'shell', env: 'shell', gradle: 'groovy', tf: 'hcl',
  tfvars: 'hcl', mdx: 'markdown', gotmpl: 'handlebars', tmpl: 'handlebars', proto: 'protobuf', h: 'cpp', hpp: 'cpp',
  cc: 'cpp', mm: 'objective-c', svg: 'xml', plist: 'xml', csproj: 'xml', xaml: 'xml',
};

export function languageFor(path) {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith('dockerfile') || name.endsWith('.dockerfile')) return 'dockerfile';
  if (name.startsWith('.env')) return 'shell';
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (BY_EXT[ext]) return BY_EXT[ext];
  const known = monaco.languages.getLanguages().find(l =>
    (l.extensions || []).some(e => e.toLowerCase() === '.' + ext) || (l.filenames || []).some(f => f.toLowerCase() === name));
  return known ? known.id : 'plaintext';
}

export function languageName(id) {
  const l = monaco.languages.getLanguages().find(x => x.id === id);
  return (l && l.aliases && l.aliases[0]) || id;
}

// For debugging from the browser console.
window.monaco = monaco;

export { monaco };
