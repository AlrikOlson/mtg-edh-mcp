# Agent skills for MTG Commander

The package includes five portable Agent Skills that explain how to use the MTG MCP tools together. Install them into a supported client's skills directory, then verify that the client discovers them. A skill supplies instructions and references; the MTG MCP connection must already be configured and available in that client. See [installation](INSTALL.md) for server setup.

| Skill              | Use it for                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `mtg-edh`          | Starting a session, choosing a workflow, checking data readiness, recovering from tool errors, and routing all 56 tools. |
| `mtg-edh-cards`    | Card search and discovery, exact cards and faces, mechanics, rulings, and rules evidence.                                |
| `mtg-edh-decks`    | Building decks, preserving intent, reviewing proposed changes, and applying incremental edits.                           |
| `mtg-edh-analysis` | Deck statistics, strategy, mana sequencing, legality, combos, and policy checks.                                         |
| `mtg-edh-budget`   | Printing selection, deck value, acquisition estimates, budget swaps, and owned-card membership.                          |

Each folder in `skills/` contains `SKILL.md`, its own references, and a license. The folders have no cross-skill file dependencies. Install all five for the complete routing and workflow guidance, or select a subset for a narrower purpose. The more detailed [agent cookbook](AGENT-COOKBOOK.md) remains useful background.

## Install from a local package

Use a reviewed local release or an unpacked package containing `dist/skills.js` and `skills/`. The commands below run from that package directory with a supported Node.js version. This standalone installer needs no `npm ci`, `node_modules`, native SQLite addon, or running MCP server. A source checkout still needs its build dependencies and a build first. The installer uses the bundled skill files without downloading a replacement package, consulting a registry, or publishing anything.

The package also exposes the `mtg-edh-skills` executable. The existing `node dist/main.js skills ...` alias remains available through the main runtime; use the standalone entry point below for installation without runtime dependencies.

List the bundled skills:

```sh
node dist/skills.js list
```

Preview a user installation for Codex, review the destination and actions, then apply it:

```sh
node dist/skills.js install --client codex --scope user
node dist/skills.js install --client codex --scope user --apply
```

Installation and removal are **previews by default**. `--apply` authorizes the filesystem changes displayed by the preview. A client is required unless you supply `--dest`; the installer does not guess a client from files on your machine. Scope defaults to `project`.

For a project installation, explicitly identify the project when running from a separate release directory:

```sh
node dist/skills.js install --client claude --project-root /path/to/project
node dist/skills.js install --client claude --project-root /path/to/project --apply
```

Without `--project-root`, project scope uses the current working directory. `--project-root` is only valid for project scope. Keep the project directory separate from the bundled source skills.

Use repeated `--skill` options to select specific skills:

```sh
node dist/skills.js install --client cursor --scope user --skill mtg-edh --skill mtg-edh-analysis
node dist/skills.js install --client cursor --scope user --skill mtg-edh --skill mtg-edh-analysis --apply
```

The supported client names are `agents`, `codex`, `claude`, `cursor`, `copilot`, `vscode`, `gemini`, and `opencode`. The `agents` preset chooses the shared `.agents/skills` location; it is not a promise that every harness discovers it.

## Update or remove a managed installation

Run an update from the local package containing the skill revision you want. Changing an existing skill requires an installation owned by this installer whose files still match its receipt. Selected skills that are absent are installed normally:

```sh
node dist/skills.js install --client codex --scope user --update
node dist/skills.js install --client codex --scope user --update --apply
```

Removal uses the same destination and skill selectors:

```sh
node dist/skills.js uninstall --client codex --scope user
node dist/skills.js uninstall --client codex --scope user --apply
```

Add repeated `--skill` options to update or remove only selected skills. Review every preview, including conflicts. Any conflict blocks the whole selection. Locally edited or unmanaged folders are preserved; there is no force-overwrite option. If you customized a skill, retain your version and compare it with the new bundled copy before deciding how to reconcile it.

## Explicit destinations and manual use

`--dest` names a skills directory, with each selected skill installed beneath it. It can replace `--client` when the correct destination is already known:

```sh
node dist/skills.js install --dest /path/to/client/skills
node dist/skills.js install --dest /path/to/client/skills --apply
```

Choose a directory documented by your client. A successful copy into an arbitrary directory does not establish automatic discovery. `--dest` cannot be combined with `--client`, `--scope`, or `--project-root`. Use the same `--dest` for subsequent updates or removal. Avoid installing duplicate skill names into several compatibility locations: hosts differ in how they handle collisions.

Manual installation also works: copy a whole `skills/<skill-name>/` folder, including its references and license, into the chosen skills directory. The installer treats a manual copy as unmanaged and will not overwrite or uninstall it.

For a harness with filesystem access but no native skills feature, explicitly ask its agent to read the selected `SKILL.md` and follow its relative references. This is manual instruction loading, not native skill installation. If a host cannot access those files, it still receives the MCP server's individual tool descriptions. The server also offers `build_commander_deck`, `tune_deck`, and `fit_budget` prompts when the host exposes MCP prompts. These surfaces do not replace the full skill bundle.

## Documented discovery locations

The following paths were checked against official documentation on **2026-09-09**. Each directory contains `<skill-name>/SKILL.md`. These are documented host capabilities; this project does not claim to have run native discovery tests in every host or version.

| Installer client | Project skills directory | User skills directory        | Official documentation and caveat                                                                                                                                                                                                          |
| ---------------- | ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agents`         | `.agents/skills/`        | `~/.agents/skills/`          | Shared convention supported by the hosts noted below. No universal discovery guarantee.                                                                                                                                                    |
| `codex`          | `.agents/skills/`        | `~/.agents/skills/`          | [Codex skills](https://learn.chatgpt.com/docs/build-skills): scans project ancestors through the repository root. Duplicate names can both appear.                                                                                         |
| `claude`         | `.claude/skills/`        | `~/.claude/skills/`          | [Claude Code skills](https://code.claude.com/docs/en/skills): local personal skills do not transfer to Cowork or cloud sessions. The documentation does not list `.agents/skills` as a discovery path.                                     |
| `cursor`         | `.cursor/skills/`        | `~/.cursor/skills/`          | [Cursor skills](https://prod.cursor.com/docs/skills): also accepts `.agents` paths. Personal Cloud Agent sync is optional and applies only to `~/.cursor/skills/`.                                                                         |
| `copilot`        | `.github/skills/`        | `~/.copilot/skills/`         | [GitHub Copilot skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills): also accepts project `.claude`/`.agents` and user `.agents` paths. Availability depends on the Copilot experience and organization policy. |
| `vscode`         | `.github/skills/`        | `~/.copilot/skills/`         | [VS Code skills](https://code.visualstudio.com/docs/agent-customization/agent-skills): also accepts project/user `.claude` and `.agents` paths. `chat.agentSkillsLocations` is deprecated and applies only to the Local agent.             |
| `gemini`         | `.gemini/skills/`        | `~/.gemini/skills/`          | [Gemini CLI skills](https://geminicli.com/docs/cli/using-agent-skills/): `.agents` paths are supported aliases. Workspace skills require trust.                                                                                            |
| `opencode`       | `.opencode/skills/`      | `~/.config/opencode/skills/` | [OpenCode skills](https://opencode.ai/docs/skills): also accepts `.claude` and `.agents` paths. Agent permissions can hide or disable skills.                                                                                              |

After installation, inspect the host's discovered skills before relying on automatic activation. Codex offers `/skills` and `$` mentions; Claude Code offers `/skills`; Cursor exposes Customize → Skills; VS Code offers `/skills`; Gemini CLI offers `/skills list` and `/skills reload`. Restart the client if needed. For Claude Code, a newly created top-level skills directory can require a restart. Local skills need separate distribution to a remote environment when the host does not synchronize them.

## Portable format and boundaries

The bundle uses the [Agent Skills specification](https://agentskills.io/specification): YAML frontmatter followed by Markdown, with required `name` and `description`. Names contain 1–64 lowercase alphanumeric characters and single hyphens, match their containing directory, and have no leading, trailing, or consecutive hyphens. Descriptions contain 1–1024 characters describing purpose and activation conditions.

The specification also defines optional `license`, `compatibility` (1–500 characters), `metadata` (string-to-string entries), and experimental `allowed-tools`. This bundle does not rely on host-specific tool allowlists, shell interpolation, or subagent invocation fields. The specification recommends a main body below 5,000 tokens and 500 lines; these are guidance rather than mandatory limits. References use paths relative to the skill root and are directly linked from `SKILL.md`.

The one-folder-per-skill layout also meets [Gemini CLI's discovery constraints](https://geminicli.com/docs/cli/tutorials/skills-getting-started/): exact `SKILL.md` capitalization, frontmatter at the beginning of the file, and no category directory between the skills root and skill folder. Host trust and consent requirements still apply.

An agent may expose MCP tools under a namespace or discover them lazily. The skills instruct it to use the live tool schema and available connection rather than assume a specific harness prefix. Skills do not grant missing tools, bypass permissions, or guarantee that an arbitrary agent selects them automatically. For example, the [Copilot SDK](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/skills) configures skill directories and requires explicit skill assignment for subagents.

## Installation safety and provenance

The installer changes only the selected skill folders and its management files in the chosen destination. It does not edit MCP configuration, modify other clients' skill directories, make network requests, or execute bundled skill content. Preview performs no installation changes.

Managed folders contain `.mtg-edh-install.json`, which records ownership and file checksums. Updates and removal check that the complete installed payload remains unchanged. Extra, missing, or edited files cause a conflict so local work is preserved. Keep the receipt intact if you want managed updates or removal.

Checksums establish content identity and detect changes; they are **not a signature or proof of publisher identity**. Review where the local package came from and the files you are installing. The installer does not authenticate a remote publisher or turn an untrusted package into a trusted one.

A destination lock prevents overlapping installer operations. Changes are staged, and ordinary failures trigger rollback. A hard interruption can leave `.mtg-edh-install.lock/owner.json` identifying the transaction directory for inspection. A rollback failure also retains recovery information. Do not delete a live installer's lock or run a second installer against that destination. If an earlier process has stopped, inspect the owner record, transaction contents, and destination before deciding how to recover; there is no automatic force-recovery command.

## Verification scope

The checks below address different claims. On 2026-09-09, all 38 installer tests and 29 CLI function tests passed. Repository tests cannot prove that every supported host has loaded a skill, and a valid skill format cannot prove that an agent will choose the best tool on every task.

| Evidence                                            | What it establishes                                                                                                                                                | What remains outside that check                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| 38 installer tests in `src/skills/`                 | Real filesystem preview/apply, idempotency, subsets, ownership and conflict preservation, scoped removal, locks, and fault-injected rollback.                      | Native host discovery, activation quality, and all possible process or filesystem failures. |
| 29 CLI function tests in `src/skills/`              | All eight client presets in both scopes, paths with spaces, arguments and conflict exit status; actual copies to an explicit destination and OpenCode user preset. | Shell executable launch or native host discovery.                                           |
| Skill bundle validation and tool catalog comparison | Valid metadata, contained relative references, and coverage of the server's 56 registered tool names.                                                              | Agent judgment or the correctness of an arbitrary future server schema.                     |
| Local package smoke test (`npm run test:package`)   | The built package contains the expected runtime and bundled artifacts, as checked by that test.                                                                    | A registry publication or remote installation; neither is required for this workflow.       |
| Dated official host documentation above             | The documented discovery paths and host-specific limitations used for the presets.                                                                                 | Native discovery tests in all listed applications.                                          |
| A discovery check in your chosen host               | That this installed revision is visible in that host and environment.                                                                                              | Availability of the MCP connection until separately checked.                                |

For a practical first run, explicitly invoke `mtg-edh`, confirm that the agent can find the live MTG tools, and have it call `data_status` before a read-only card lookup. Check that it reports available data and uncertainty from the actual tool results. This verifies the installed guidance and MCP connection together without requiring a deck or collection mutation.
