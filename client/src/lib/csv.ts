const SPREADSHEET_PREFIX = /^[\t\r\n]|^[\s\uFEFF]*[=+\-@＝＋－＠]/u;

/** Escape CSV delimiters and keep spreadsheet-sensitive strings as literal text. */
export function quoteCsvCell(value: string | number | boolean | null | undefined): string {
  const text = String(value ?? "");
  const literal = typeof value === "string" && SPREADSHEET_PREFIX.test(text) ? "'" + text : text;
  return '"' + literal.replace(/"/g, '""') + '"';
}
