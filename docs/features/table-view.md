# CSV & TSV Table View

`.csv` and `.tsv` files open in the editor as text. **View: Open Table Preview** (the table button in the editor title bar, or the Command Palette) opens a table tab beside it, titled `Table <file>`; its toolbar shows the row and column count and has **Open as Text** to go back to the source.

---

## How the table reads the file

- **Correct CSV parsing**: quoted cells can hold commas, quotes and line breaks. Stray quotes in unquoted cells are accepted as literal text instead of failing the file.
- **Delimiter from the file**: px0 reads the first line and splits on whichever of comma, tab, semicolon or pipe it uses most, ignoring any inside quotes. A tab-separated file named `.csv` or a semicolon export from a European spreadsheet still gets proper columns. The extension only breaks ties (`.csv` → comma, `.tsv` → tab).
- **Header row**: the first record is the header. A UTF-8 byte order mark at the start of the file is dropped.
- **Line-number column**: the first column shows each row's source line. A row whose quoted cell spans two lines makes the numbering skip (7, then 9), so the numbers match the text view.
- **Uneven rows**: a row with fewer cells than the header leaves the rest empty; a row with more cells widens the table under blank headings.
- **Plain text only**: cell contents are shown as text. Markup in a cell such as `<b>` appears as typed.
- **Large files**: the table shows the first 1,000 rows (or the first 1 MB), and the toolbar says `(truncated)`. Use **Open as Text** for the rest. Opening a 50 MB file takes the same time as opening one at the cap.

The table is read when the tab opens; reopen it after editing the file.

For the endpoint (`/api/table`), the caps and how rows map to source lines, see [Table Preview](../internals/markdown.md#9-table-preview-csv--tsv) in the preview internals.
