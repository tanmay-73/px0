# Syntax Highlighting & Language Support

The editor highlights code with Monaco's Monarch tokenizers, the same highlighters VS Code's web editor uses, running in the browser as you type. The colours come from the active px0 theme, so the editor, diffs and Markdown code blocks share one palette.

---

## Languages

px0 bundles Monaco's Monarch highlighters for about 80 languages, including Go, Rust, C/C++, C#, Java, Kotlin, Scala, Swift, Dart, Python, Ruby, PHP, Perl, Lua, Julia, R, Elixir, Clojure, F#, Scheme, JavaScript, TypeScript, HTML, CSS/SCSS/Less, GraphQL, Markdown, YAML, XML, INI, HCL, Protobuf, SQL dialects, Shell, PowerShell, Dockerfile and Solidity.

- **JSON** (`.json`, `.jsonc`, `.json5`, ...) gets a small Monarch highlighter of px0's own, because Monaco's JSON support comes with a language service px0 leaves out.
- px0 maps a few names Monaco does not know: `Makefile`, `justfile` and dotfiles such as `.bashrc` and `.env` as shell; `go.mod` / `go.work` as Go; `.toml`, `.conf`, `.cfg`, `.editorconfig` as INI; `.tf` as HCL; `.tsx`, `.mjs`, `.cjs`, `.mts`; `.svelte` / `.vue` as HTML; `.gotmpl` / `.tmpl` as Handlebars; `.svg` and `.plist` as XML.
- Anything else opens as plain text. Click the language in the status bar (**Select Language Mode**) to pick another for the file.

Monaco's TypeScript/JavaScript, HTML, CSS and JSON *language services* (their IntelliSense and validation workers) are not bundled: they are megabytes of code and the [language servers](lsp-code-intelligence.md) cover the same ground. Their Monarch highlighters are kept.

## Editor features that go with it

These are Monaco features, controlled by settings (see [Settings](settings-and-configuration.md)):

- **Bracket pair colorization** and bracket guides (`editor.bracketPairColorization.enabled`).
- **Occurrence highlighting** of the word under the cursor, and of the selection.
- **Current line highlight** (`editor.renderLineHighlight`).
- **Sticky scroll** of the enclosing scopes (`editor.stickyScroll.enabled`).
- **Whitespace rendering** (`editor.renderWhitespace`), **rulers** (`editor.rulers`), **minimap** (`editor.minimap.enabled`).

## Highlighting on the server

The server still has its own highlighter, [Chroma](https://github.com/alecthomas/chroma), for ~280 languages. It colours fenced code blocks in the [Markdown preview](markdown-preview.md) and the windowed `/api/file` endpoint. Both use the same theme tokens as the editor. See [Windowed Syntax Highlighting Internals](../internals/syntax-highlighting.md).
