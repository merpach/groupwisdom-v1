// Converts the ESM output to a CJS bundle so the package works with require()
import { readFileSync, writeFileSync } from "fs";

const esm = readFileSync("dist/index.js", "utf8");

const cjs = esm
  .replace(/^export default /m, "module.exports = ")
  .replace(/^export \{ ([^}]+) \};/m, (_, names) => {
    return names.split(",").map(n => {
      const name = n.trim();
      return `module.exports.${name} = ${name};`;
    }).join("\n");
  })
  .replace(/^export (const|function|class) (\w+)/gm, "$1 $2")
  .replace(/^import (.+) from ['"](.+)['"]/gm, 'const $1 = require("$2")');

writeFileSync("dist/index.cjs", cjs);
console.log("CJS bundle written to dist/index.cjs");
