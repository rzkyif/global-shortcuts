#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import * as readline from "node:readline";

const newVersion = process.argv[2];

if (!newVersion) {
  console.error("Usage: bun run release <version>");
  console.error("Example: bun run release 2.0.0");
  process.exit(1);
}

// Validate version format (basic semver check)
if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error(`Invalid version format: "${newVersion}"`);
  console.error("Expected semver format (e.g., 2.0.0)");
  process.exit(1);
}

const changes = [];

// Update Cargo.toml
const cargoPath = "Cargo.toml";
const cargoContent = readFileSync(cargoPath, "utf-8");
const cargoVersionMatch = cargoContent.match(/^version\s*=\s*"([^"]+)"$/m);
const oldCargoVersion = cargoVersionMatch ? cargoVersionMatch[1] : "unknown";
const newCargoContent = cargoContent.replace(
  /^version\s*=\s*"[^"]+"$/m,
  `version = "${newVersion}"`,
);
writeFileSync(cargoPath, newCargoContent);
changes.push({
  file: "Cargo.toml",
  old: oldCargoVersion,
  new: newVersion,
});

// Update package.json
const pkgPath = "package.json";
const pkgContent = JSON.parse(readFileSync(pkgPath, "utf-8"));
const oldPkgVersion = pkgContent.version;
pkgContent.version = newVersion;

// Update optionalDependencies versions
if (pkgContent.optionalDependencies) {
  const oldOptionalDeps = { ...pkgContent.optionalDependencies };
  for (const dep in pkgContent.optionalDependencies) {
    pkgContent.optionalDependencies[dep] = newVersion;
  }
  changes.push({
    file: "package.json (optionalDependencies)",
    old: JSON.stringify(oldOptionalDeps, null, 2),
    new: JSON.stringify(pkgContent.optionalDependencies, null, 2),
  });
}

// Track main version change
if (oldPkgVersion !== newVersion) {
  changes.unshift({
    file: "package.json (version)",
    old: oldPkgVersion,
    new: newVersion,
  });
} else {
  changes.unshift({
    file: "package.json (version)",
    old: oldPkgVersion,
    new: newVersion,
  });
}

writeFileSync(pkgPath, JSON.stringify(pkgContent, null, 2) + "\n");

// Display changes
console.log("\n=== Release Summary ===");
console.log(`New version: ${newVersion}\n`);

for (const change of changes) {
  console.log(`--- ${change.file} ---`);
  console.log(`  Old: ${change.old}`);
  console.log(`  New: ${change.new}\n`);
}

// Ask for confirmation
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("Confirm release? [y/N] ", (answer) => {
  rl.close();

  if (answer.toLowerCase() === "y") {
    const tagName = `v${newVersion}`;
    try {
      console.log("\nStaging changed files...");
      execSync("git add Cargo.toml package.json", { stdio: "inherit" });
      console.log("Files staged.");

      console.log(`\nCommitting with message "release: ${tagName}"...`);
      execSync(`git commit -m "release: ${tagName}"`, { stdio: "inherit" });
      console.log("Changes committed.");

      console.log("\nPushing changes...");
      execSync("git push", { stdio: "inherit" });
      console.log("Changes pushed successfully.");

      console.log(`\nCreating git tag ${tagName}...`);
      execSync(`git tag ${tagName}`, { stdio: "inherit" });
      console.log(`Tag ${tagName} created.`);

      console.log("\nPushing tags...");
      execSync("git push --tags", { stdio: "inherit" });
      console.log("Tags pushed successfully.");
    } catch (error) {
      console.error("Git operations failed:", error.message);
      process.exit(1);
    }
  } else {
    console.log("Release cancelled.");
    process.exit(0);
  }
});
