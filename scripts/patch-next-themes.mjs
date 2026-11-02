import fs from "node:fs";
import path from "node:path";
const root = path.resolve("node_modules/next-themes");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.version !== "0.4.6") throw Error("Review next-themes patch before upgrading from 0.4.6");
for (const name of ["index.js", "index.mjs"]) {
    const file = path.join(root, "dist", name);
    let source = fs.readFileSync(file, "utf8");
    if (source.includes("/* hyoai-memory-theme-v2 */")) continue;
    if (!source.includes("/* hyoai-cache-only */")) {
        const listener =
            /window\.addEventListener\("storage",([a-zA-Z]+)\),\(\)=>window\.removeEventListener\("storage",\1\)/;
        if (!listener.test(source)) throw Error("Unknown next-themes storage listener");
        source = source.replace(listener, "void 0,()=>{}");
    }
    const reads = source.match(/localStorage\.getItem\([a-z]+\)/g),
        writes = source.match(/localStorage\.setItem\([a-z]+,[a-z]+\)/g);
    if (reads?.length !== 2 || writes?.length !== 1)
        throw Error("Unknown next-themes persistence implementation");
    source = source
        .replace(/localStorage\.getItem\([a-z]+\)/g, "(void 0)")
        .replace(/localStorage\.setItem\([a-z]+,[a-z]+\)/g, "void 0");
    fs.writeFileSync(file, source + "\n/* hyoai-memory-theme-v2 */\n");
}
