// Markdown imported with `with { type: "file" }` resolves to a path: a file on disk in a
// source checkout, or an embedded file inside a compiled executable. Bun.file reads both.
declare module "*.md" {
  const path: string;
  export default path;
}
