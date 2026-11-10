# DSH-X Environment / Profile Split Plan

**Status:** Implemented, all three phases, in the fork (`origin`) on one branch; it goes to upstream (`upstream`, yyh's repository) as one PR and one commit (the three phases were built and tested together, so per-phase commits would be states that never ran). Requirements came from a requirements-alignment session on 2026-11-11; decisions taken during implementation are under "Implementation notes".

**Goal:** Split "DSH version + plugins" out of the profile into an "Environment" that can be created, exported, imported and updated from an upstream. A Profile keeps only configuration and data. A launch entry picks one Environment and one Profile.

**Architecture:** An Environment is a manifest in the launcher's data directory (DSH version, versioned plugin list, optional offline files, upstream source, local delta). dsh only understands a profile directory, so before launch the launcher writes the chosen Environment's plugin list into the chosen Profile's directory and installs dependencies only when they differ. Configuration is always read from and written to the Profile directory. Environment files keep the `.dspack` format (PackForge manifest v5).

**Tech Stack:** Node built-in modules, the existing `packs.js` / `zip.js` / `registry.js`, and the plain HTML/JS management page. No new runtime dependencies.

---

## Why

- DSH changes its interface protocol often, and a plugin can break when the DSH version changes. What actually works is a combination of one DSH version and one set of plugin versions, so the combination has to be locked and shared as a whole.
- The community can maintain its own Environments. Later users pick one and follow its upstream instead of hunting for plugins or spending tokens rewriting them. The analogy is Minecraft modpacks and Linux distributions.
- dsh itself does not manage version combinations, so only the launcher can do this.

## Current state and gaps

The modpack feature from late September already has: import (local file, directory, direct link, GitHub `owner/repo`, community market), a pre-install preview, backup and rollback, and export of the current profile.

Gaps against the goal:

- `dshVersion` is only displayed. Export does not write it, install does not check it, and launch does not use it.
- Export writes plugins with local paths (`link:` / `file:`) verbatim, so they cannot be installed on another machine.
- `github:` plugins are not pinned to a commit, so other users get whatever the latest commit is at install time.
- Export includes the whole patch layer, which holds the MCP `env` / `headers` where secrets usually live.
- "Update" upgrades each plugin in the pack to the latest npm version instead of following the pack's upstream. The source in the install record is only a description, so the repository cannot be looked up from it.

## Decisions

| # | Question | Decision |
|---|---|---|
| 1 | What is in a pack | DSH version number + plugin list (with version numbers). Each item may carry offline install files. No configuration, plugin configuration, skills, presets or user data |
| 2 | What it is called | The modpack is renamed "Environment" (环境) |
| 3 | Relationship between Environment and Profile | Fully separate. A Profile has no plugins and is not bound to a version. A launch entry picks one Environment and one Profile |
| 4 | How they are combined | Before launch, the Environment's plugin list is written into the Profile directory |
| 5 | Local changes to an Environment that follows an upstream | Stored as "upstream + local delta"; the delta is replayed when the upstream updates |
| 6 | What the upstream is | The releases of the Environment's own GitHub repository |
| 7 | Who publishes | The maintainer publishes manually (git + release). The launcher only exports a repository directory that can be committed as is |
| 8 | Offline files | Phase 1 covers local plugins only. A custom DSH build is deferred; the format reserves a slot for it |
| 9 | Lock depth | Direct dependencies only |
| 10 | Configuration and skills inside old packs | They are Profile data. Skipped by default on import, with an option to import them into the chosen Profile (this is an interpretation of the answer; see "Defaults") |
| 11 | File format | Unchanged; still `.dspack` |
| 12 | What to build first | Split the core model first |
| 13 | Old data | When the new version starts and finds data in the old shape, it migrates it to the new shape. Required in Phase 1 |
| 14 | Can the old version still run after migration | Yes. Migration is additive only; old fields keep being written |

## The three objects

| Object | Has | Does not have |
|---|---|---|
| Environment | DSH version; plugin list (per item: name + exact version / commit / offline file); bundle stack order; upstream source; local delta | Configuration, plugin configuration, skills, presets, sessions, memory, credentials |
| Profile | The patch layer `cordis.patch.yml` (plugin switches, plugin configuration, MCP) and the other files in the Profile directory | Plugins, DSH version |
| Launch entry | One Environment + one Profile + home directory, port, working directory | — |

Sessions, memory, skills and credentials live at the root of `DSH_HOME` and are shared by every Profile in that directory. They are not inside any one Profile directory, but the same rule applies: an Environment never touches them.

## How it lands on disk

dsh only understands a profile directory. The plugin list (`dependencies` and `dsh.profile.bundles` in `package.json`), `node_modules` and the patch layer all live in it, and configuration changed at runtime is written back to it. So the split can only be assembled by the launcher before launch.

- **Before launch**: compare the plugin list in the Profile directory with the chosen Environment (upstream layer + local delta). If they match, launch directly. If not, rewrite the list and run one dependency install (the existing `runProfileInstall` path), then record which Environment and which version of it this directory now corresponds to.
- **A failed install must restore the list**: back up before writing, restore on failure. In testing, a failed install leaves the list switched and `node_modules` not switched; dsh still starts, but none of the new Environment's plugins load and the user cannot tell why.
- **Pick pnpm per directory**: this path must reuse the existing `preferredPnpmDir` and use the pnpm major version that installed the directory. In testing, crossing major versions fails outright.
- **Dangling configuration is left alone**: configuration in a Profile that targets a plugin is ignored by dsh when the Environment lacks that plugin. The file is not rewritten, and the configuration applies again when the plugin returns.
- **No links**: `node_modules` is not made a link to the Environment. Windows junctions already have two known failure modes; waiting for one install on the first launch after switching Environments is the safer cost.
- **When an instance stops**: compare again and fold any plugins installed or removed inside dsh during the run into that Environment's local delta, without a prompt and without discarding anything.
- **Concurrency constraint**: instances running on the same Profile at the same time must use the same plugin list. Environments that differ only in DSH version can still run concurrently; different plugin lists need two Profiles.
- **Two rejected approaches**:
  - `--patch` overlay: configuration changed by dsh at runtime would be written into the Environment directory and never reach the Profile.
  - The dsh internal boot interface (`resolvedProfile` on `runProfile`, with separate directory and patch path): it is internal and missing from older DSH versions, and Environments need to pin exactly those older versions.

## The Environment file

- **Container and manifest**: `.dspack` (ZIP) with `dspack.json` + `manifest.json` (manifest v5), reusing `dshVersion`, `dependencies` and `bundles`. Packs already in the community market can be imported as Environments, and PackForge tools can read what we export.
- **Export writes only**: name, version, description, `dshVersion`, `bundles`, `dependencies` and offline files. It no longer writes the patch layer, `overrides/`, `home/` or the `package.json` snapshot.
- **How direct dependencies are pinned**:
  - npm plugins: exact version (the existing `pinSpec`).
  - `github:` plugins: pinned to the currently installed commit.
  - Local-path plugins: packed as a tarball by `npm pack` rules and placed inside the pack, with a sha256. The author can deselect them one by one; deselected ones produce a warning in the export result.
  - DSH: exact version.
- **Boundary of offline files**: they only guarantee that the item itself does not depend on the cloud. Its own dependencies are still installed from npm; this is not a fully air-gapped install. The manifest reserves the same slot for DSH, not implemented in Phase 1.
- **Transitive dependencies are not locked**: `pnpm-lock.yaml` is not included.
- **Field shapes** (how the manifest references offline files, where the source is recorded) are decided during implementation. The rule is to add optional fields only and not bump `manifestVersion`.
- **Importing third-party / old packs**: only the DSH version and plugins are taken to build an Environment. The pack's patch layer, overrides, skills and presets are skipped by default and listed, with an "import into the chosen Profile" option that uses the existing write, backup and rollback path.
- **Old packs whose `dshVersion` is a range**: take the highest locally installed version that satisfies the range; if none, install the latest version that satisfies it. The Environment records the exact version.
- **Two export targets**: a single `.dspack` file, or a "repository directory" where the manifest and offline files are written straight into a folder the user picks, optionally with a GitHub Actions template that produces a release when a tag is pushed. Committing, tagging and pushing are done by the user; the launcher never calls GitHub write APIs and stores no token.

## Following an upstream

- Upstream = the releases of the GitHub repository the Environment lives in, reusing the existing convention of taking the `.dspack` from the latest release of `owner/repo`.
- The Environment records its source in structured form: the repository, and which release and pack version is installed.
- Steps to apply an update: replace the upstream layer → replay the local delta → list the differences (DSH version change, plugins added / removed / changed, delta items that duplicate or conflict with the new upstream) → user confirms → back up the old manifest so it can be switched back.
- If the required DSH version is not installed locally, it is installed during import or update.
- Plugins in the delta have not been verified by the upstream author. When the upstream changes DSH version the launcher only warns, and the user decides whether to keep them.
- The current "update modpack = upgrade each plugin in the pack to the latest npm version" is retired.

## Old data migration

When the new launcher starts and finds data in the old shape, it migrates it to the new shape.

**Where old data lives**

| Location | Old shape | Migrated to |
|---|---|---|
| `launchPresets` in `settings.json` | Launch entry = version + profile | An Environment field is added |
| `profiles/<name>/package.json` under each `DSH_HOME` | The plugin list lives in the profile | Read to generate an Environment manifest; the file itself is not changed |
| `data/packs/installed.json` and `data/packs/backups/` | Modpack install records | Converted into the source information of the matching Environment; the original files stay |
| `instancePorts` / `environmentPorts` / `autoPorts` in `settings.json` | Keyed by `version@profile` | Not migrated; the key can still be derived from the Environment's DSH version and the Profile |
| `plugin-profile/<version>@<profile>.json` | Plugin profiling reports | Not migrated; they can be regenerated |

Profiles are not only in the default `~/.dsh`. A launch entry can carry its own `dshHome`, and the launcher also creates isolated directories under `data/homes/`. Migration has to scan every directory that appears in launch entries and settings.

Settings currently have no version number and no migration framework; bad data is dropped at read time by the `safe*` functions. This is the first migration.

**How**

- **Detect per item**, not through one global "migrated" flag. There are two old shapes: a launch entry without an Environment field, and a Profile directory that has a plugin list but no matching Environment. Each is adopted when seen.
- **Repeatable with a deterministic result**: the same profile in the same directory always maps to the same Environment, so re-running never creates duplicates.
- **Timing**: at core startup, before the management page becomes available and before auto-launch entries start instances. It only reads manifest files, installs nothing and uses no network, so it does not slow startup.
- **Backup**: `settings.json` is backed up once before it is first rewritten.
- **Failure**: one failed item does not block the others or the launcher's startup. Failed items are retried on the next start and written to the log.

**Generation rules**

- Each profile produces one Environment with the same name, with the plugin list taken from its `package.json`.
- When profiles with the same name in different directories have different plugin lists, the directory name is added to the Environment name to tell them apart.
- When one profile is used by several launch entries with different DSH versions, one Environment is generated per version. Their plugin lists are identical, so they can still run concurrently.
- When a launch entry's version is "auto": the Environment's DSH version is recorded as "follow the latest in a channel", so behavior stays as it is today. On export it is frozen to the exact version in use at that moment.
- Installed modpack records become the Environment's source information. When the repository cannot be identified from the source, the Environment is marked "not following".

**Why migrating once is not enough**

- Old-shape data reappears after migration: a `settings.json` restored from backup, profiles created outside the launcher (the dsh CLI, the official desktop app), and plugin lists synced from another machine still on the old version.
- The launcher's own sync engine currently syncs `package.json` per profile and takes the union of both sides. Phase 1 leaves it unchanged; synced-in plugins are folded into the Environment as local delta. Later it should sync Environments themselves.

**Rollback compatibility**

Required: migration is additive only. An old version reading new data is not hypothetical, because the launcher's own safety nets trigger it. If the core has not come up within 45 seconds of a core update, the old core is swapped back in. If a new core cannot start, the shell falls back to the baseline core bundled in the installer, which is older still.

- **Old fields keep being written**: launch entries still carry a valid `version` and `profile`. The old version drops a whole launch entry when its version is invalid, so the version cannot simply be moved onto the Environment.
- **New data lives elsewhere**: Environment manifests go to a new location in the data directory that the old version never reads. `package.json` in the Profile directory stays complete anyway, so the old version keeps working.
- **Keeping the dual-write consistent**: the Environment is the source of truth for the DSH version. `version` on the launch entry is a copy, written together whenever a launch entry or Environment is saved.
- **Upgrading again after a rollback**: when the old version saves settings it deletes fields it does not know, including the Environment field, so launch entries revert to the old shape. Per-item detection and repeatable adoption catch this and map them back to the original Environment.
- **Last writer wins**: a launch entry with an Environment field was last saved by the new version, so the Environment wins. A launch entry without one was last saved by the old version, so the old fields win: if the version differs from the one recorded in the Environment, the Environment is updated; plugins added to or missing from the Profile directory are folded into the local delta.
- **When the dual-write can be removed**: keep it at least until the next major version, and until the baseline core bundled in the installer also understands Environments.

---

### Step 0: Verification before starting (done, 2026-11-11)

Both checks passed, so the "write into the Profile directory" approach holds.

Test conditions: macOS, DSH 0.2.2-rc.1 (the dangling scenario was re-run on 0.2.1-rc.2), system Node 24, a temporary `DSH_HOME`.

**Check 1: dangling configuration. Passed; dangling entries need no handling when switching Environments.**

| Scenario | Result |
|---|---|
| The patch layer has a configuration entry for a plugin (`id` + `name` + `config`) and the plugin is absent | Starts normally and the entry is ignored; `--dump-config` reports `patch: entry "…" not found` |
| The patch layer has a disable entry for a plugin (`id` + `disabled`) and the plugin is absent | Same as above |
| After starting with dangling entries | The patch layer file is not rewritten; the configuration applies again once the plugin is reinstalled |
| The patch layer explicitly `insert`s a package that is not installed | Starts normally with the warning `1 entry did not activate`; that row does not load |
| The list names plugins but dependencies are not installed | Starts normally, prints `skipping profile bundle` for each; those plugins do not load |

**Check 2: reinstalling dependencies when switching Environments. Passed, with one precondition.**

Environment A is 11 npm plugins (68 packages in total) and Environment B is 4 of them, switched back and forth in the same Profile directory.

| Operation | pnpm 10.33.0 | pnpm 11.27.1 |
|---|---|---|
| First install of A | 4.5 s (19 packages downloaded) | 4.3 s (68 packages downloaded) |
| A → B | 0.7 s | 0.7 s |
| B → A | 1.4 s | 1.3 s |
| List unchanged, run again | 0.4 s | Not tested |

- After every switch, the installed versions matched the list and the plugins that should be removed were removed.
- Precondition: the pnpm major version that installed the directory must be used. Running pnpm 11 against a directory installed by pnpm 10 fails outright (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`) and leaves a half state where the list is switched and `node_modules` is not. Going back to pnpm 10 restores normal behavior.

**Not verified**

- Windows: the junction fallback and pnpm on Windows.
- DSH 0.1.x: not installed on this machine. The AGENTS.md note that a plugin import failure makes dsh exit immediately did not reproduce on 0.2.2-rc.1 (a missing package is only a warning); older versions may differ.
- The packaged runtime: testing used system Node, not the Node bundled with Electron.
- pnpm 8.
- Third-party plugins were only installed, not run. Boot checks used the repository's own `dsh-x-desktop-notify` and `dsh-x-aquarium`.

### Phase 1: Core model split

- Environment storage: one manifest per Environment in the launcher's data directory.
- Launch entries gain an Environment field; the existing version field moves onto the Environment.
- Write before launch, collect the delta on stop, and the concurrency constraint (see "How it lands on disk").
- Old data migration (see "Old data migration").
- Management page:
  - A new Environments page: list, create, duplicate, delete, and install / remove / upgrade plugins.
  - The page currently called 环境 (Environments) is renamed Profile.
  - The launch entry dialog picks an Environment and a Profile.
  - Plugin switches go in the launch entry (Environment × Profile) view, because the switch is stored in the Profile's patch layer while the plugin list comes from the Environment.
- Existing features that have to be re-pointed: plugin installs for Desktop Enhance and Browser Control (currently installed into "the current profile"), recovery mode, the auto-disable used by startup self-healing, settings keyed by `version@profile` (pinned ports, plugin profiling reports), and `plugin-tool.js`.
- The existing import and export are rewired to Environments in a minimal form that only understands the DSH version and plugins in the manifest. Stacking multiple packs and uninstalling in order are retired. The two built-in recipes become built-in Environments.
- At the end of this phase there are no new import / export capabilities, but launching and plugin management do not regress for existing users.

### Phase 2: Export and import of Environment files

- Export: exact DSH version, `github:` commits, offline files for local plugins, no configuration; two targets.
- Import: file, directory, direct link, GitHub and market produce an Environment; the required DSH version is installed automatically; offline files are extracted into the Environment's own directory and checked against their sha256; the configuration part of old packs can optionally be imported into a Profile.
- The pack size limit is currently 32 MB; adjust it from measurements once local plugins are included.

### Phase 3: Following an upstream

- Structured source, checking for new versions, applying updates (see "Following an upstream").

### Later

- Offline packaging of a custom DSH build. "Install a DSH version from local files" has to be defined first: today DSH can only be installed from npm, and one installed version is 500–800 MB and contains native modules compiled per platform.
- Locking transitive dependencies.
- One-click publishing from inside the launcher.

---

## Implementation notes

Decisions taken while building it. Each one fills a gap the sections above left open.

- **Storage**: Environments live beside `settings.json` in the launcher's own directory (`envs/<id>/environment.json`), not in the configurable data directory. Moving the data directory in settings moves the versions, and launch entries would lose their Environments if those moved too. `envs/state.json` holds three things: launch entry → Environment links, which Environment each Profile directory currently holds, and adopted Environments the user deleted (so migration does not adopt them again).
- **Manifest fields** (manifest v5, no version bump):
  - `offline: { "<plugin>": { "file": "offline/<name>.tgz", "sha256": "…" } }`, with the dependency written as `file:offline/<name>.tgz`.
  - `environment: { "repo": "owner/repo" }` for the upstream.
- **Offline files on disk**: `envs/<id>/files/<first 8 hex of sha256>/<name>.tgz`. An author often re-exports a changed local plugin without bumping its version, and an upstream update must not overwrite the file an archived manifest still points to.
- **Exact versions at import**: npm ranges and tags in an imported pack are pinned to the newest published version that satisfies them. Ranges in the two built-in recipes become exact versions as well.
- **The role bundle** `@deepseek-ai/dsh-web-app` (whether a Profile serves the web UI) belongs to the Profile and is not part of an Environment.
- **Recovery mode** pauses both writing the Environment before launch and collecting changes after stop.
- **Configuration import** (decision 10) is recorded as a configuration-only install record and is undone from the Profile page. It never writes the Profile's `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` or `cordis.yml`.
- **Pack size limit**: this repository's seven plugins pack to 3–187 KB each, so 32 MB stays. A single-file export over the limit is refused, because this launcher could not import it back. A folder export over the limit gets a warning.
- **Local plugins added on the Environments page** must use absolute paths. One Environment is written into several Profile directories, and a relative path points somewhere different in each.
- **Update check**: Environments listed in the market read the market index (matched by market id, or by the same repository and pack name, because one repository can publish several packs). The others read the repository's releases list (`per_page=10`, enough to skip pre-releases and drafts), cached per repository for 10 minutes. Failures are cached the same way, so an unreachable GitHub does not stall every visit to the page. One check asks GitHub once per repository. "Check for updates" bypasses the cache.
- **Which release counts**: releases without a `.dspack`/`.zip` asset are skipped. Among the rest, the highest version wins, not the most recent one, because an author can publish a fix for an older line after a newer release. An installed copy counts as a pre-release when its version looks like one or GitHub marked its release as a pre-release (the flag is stored in the Environment's source at install time).
- **Applying an update**: the old manifest is saved under `envs/<id>/history/` and can be switched back to from the Environments page. Switching back saves the current manifest first. When the upstream changes the DSH version, each local plugin change is listed with a "keep" checkbox, so the user decides per plugin. A plugin the user pinned locally and the upstream then removed keeps the local version and stays loaded. An update checked before the Environment moved to another upstream version (another tab updated it, or it was switched back) is refused instead of silently undoing that. DSH is installed only when the version the Environment will actually use is missing: a local DSH pin is kept, so the upstream's version is not downloaded for nothing.
- **Switching back** restores the plugin list, DSH version and channel, source and offline files. Name, description and adoption records stay as they are now. If auto-clean removed the DSH version the old manifest needs, it is installed first.
- **Description**: it is filled in at export and remembered; the Environments page edits only the name and the DSH version.
- **WSL launch entries** (added upstream while this was being built) do not use Environments yet. Their Profile directory lives inside WSL, where the launcher can neither write the plugin list nor install dependencies. They work exactly as before: the launch editor hides the Environment picker, and migration skips them.
- **Upstream's "启动环境" picker** (directory or WSL distro + Profile) is relabelled "目录与 Profile", so 环境 keeps a single meaning in the UI.

## Defaults (not asked one by one; open to veto)

**When to check for updates**

- Check once when the Environments page opens, plus a manual "Check for updates" button. Results are cached for 10 minutes, reusing the market index's existing cache.
- Environments listed in the market read the market index; the rest read the GitHub releases API (60 anonymous requests per hour).
- No background polling and no system notifications. A new version is only announced, never applied automatically.
- Pre-release releases are announced only when the installed one is itself a pre-release.

**Creating an Environment**

- Three entry points: create an empty Environment (pick a DSH version), duplicate an existing one, or import.
- Plugins are then installed and removed on the Environments page. Name, version and description are filled in at export time.

**Other**

- UI wording: the modpack is renamed 环境 (Environment), and the profile currently called 环境 in the UI goes back to being called Profile.
- Decision 10 is an interpretation of the answer "configuration and skills stay in the Profile"; it could also be read as "always skip".
- Plugins managed by in-dsh market plugins (not in `package.json`, for example `.dsh-market`) are not part of an Environment in Phase 1; export shows a notice.
- The Environment file keeps its extension. The GitHub Actions template is optional.

## Changes to explain to yyh in the PR

These are decided and do not wait for confirmation, but they all change behavior he wrote, so the PR description must list them one by one.

- The model itself: launch entry = Environment × Profile, and a Profile no longer has plugins.
- UI wording: 环境 (Environment) changes from meaning a profile to meaning the new object. About 140 lines in the management page, both the Chinese and English README, and the screenshot captions have to change.
- Retired: stacking multiple packs and uninstalling in order; "update modpack = upgrade each plugin to latest".
  - Retired routes: `/api/packs/inspect`, `/api/packs/install`, `/api/packs/export` and `/api/packs/update`.
  - Gone from the Profile page: import, export and the "update N" buttons. Import and export now live on the Environments page.
  - Undoing installs made by older launchers still works.
- Narrower concurrency: instances running on the same Profile at the same time must have the same plugin list.
- WSL launch entries do not get an Environment for now (see "Implementation notes").
- Where the two built-in recipes go: `dsh-x-recommended` becomes a built-in Environment; the two skills shipped with `dsh-x-workbench` become an optional item at import.

## Risks and what is unverified

- **Verification covered only part of the matrix**: macOS, DSH 0.2.1-rc.2 and 0.2.2-rc.1, pnpm 10 and 11. Windows, DSH 0.1.x, pnpm 8 and Electron's bundled Node were not tested; see "Step 0". Environments will pin various older DSH versions, which may be stricter about dangling configuration and missing packages.
- **The first launch after switching Environments** waits for one dependency install: about 1 second when the packages are cached, several seconds or more when they must be downloaded, depending on the network.
- **A failed install after writing the list** does not stop dsh from starting, but plugins silently fail to load, so the failure must be restored and reported.
- **Tests**: among the existing 300+ tests, those covering modpacks, launch entries and profiles have to be rewritten along with the model.
- **PackForge compatibility**: other tools do not understand the new offline-file field, so they will miss those items when installing an Environment that carries local plugins.
- **Offline files are executable code** and less traceable than npm. The import UI must list "this Environment carries N bundled files" separately for the user to review.
