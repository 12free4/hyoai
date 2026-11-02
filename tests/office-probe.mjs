import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "tests", "office-probe");
const action = process.argv[2];
if (!["setup", "clean"].includes(action)) throw new Error("Use setup or clean");

for (const area of ["app", "public"]) {
    const target = path.join(root, area, "anydoc-probe");
    const fixture = path.join(source, area, "anydoc-probe");
    if (action === "setup") {
        if (fs.existsSync(target)) throw new Error(`Probe path already exists: ${target}`);
        fs.cpSync(fixture, target, { recursive: true, errorOnExist: true });
    } else if (fs.existsSync(target)) {
        // Remove only files identical to this harness's templates.
        const files = fs.readdirSync(target, { recursive: true, withFileTypes: true });
        for (const entry of files) {
            if (!entry.isFile()) continue;
            const file = path.join(entry.parentPath, entry.name);
            const original = path.join(fixture, path.relative(target, file));
            if (
                !fs.existsSync(original) ||
                !fs.readFileSync(file).equals(fs.readFileSync(original))
            )
                throw new Error(`Probe file changed; preserve it before cleaning: ${file}`);
        }
        fs.rmSync(target, { recursive: true });
    }
}
if (action === "clean") {
    // Next caches route validators that otherwise still reference the removed pages.
    for (const generated of [".next/types", ".next/dev/types"])
        fs.rmSync(path.join(root, generated), { recursive: true, force: true });
}
console.log(`Office browser probe: ${action} complete`);
