#!/usr/bin/env node
import { runSkillsCli } from "./cli.js";

runSkillsCli(process.argv.slice(2))
  .then((result) => {
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `mtg-edh-skills: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
