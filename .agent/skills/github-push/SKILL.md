---
name: github-push
description: Push entire project to GitHub - init repo, commit, create remote, push. Triggers: "push to github", "upload to github", "deploy to github", "commit and push", "push project"
allowed-tools: Read, Bash, Glob, Grep
---

# GitHub Push Skill

> Complete project push to GitHub in one go: check deps, init repo, commit, create remote, push.

## Workflow

When user requests push to GitHub, follow this checklist **in order**:

### Phase 1: Check Dependencies

1. Check if `git` is installed:
   ```bash
   git --version
   ```

2. Check if `gh` CLI is installed:
   ```bash
   gh --version
   ```

3. If either is missing, install it:
   - **Windows**: `winget install Git.Git` / `winget install GitHub.cli`
   - **macOS**: `brew install git` / `brew install gh`
   - **Linux**: `sudo apt install git gh` (or equivalent)

4. Check GitHub auth:
   ```bash
   gh auth status
   ```
   If not authenticated, run `gh auth login` and guide user through login.

### Phase 2: Initialize Git Repository

1. Check if already a git repo:
   ```bash
   git rev-parse --git-dir 2>/dev/null
   ```

2. If not initialized, run:
   ```bash
   git init -b main
   ```

3. Check if `.gitignore` exists. If not, create a basic one:
   ```
   node_modules/
   .env
   .env.local
   dist/
   build/
   .next/
   *.log
   .DS_Store
   ```

### Phase 3: Commit All Files

1. Stage everything:
   ```bash
   git add -A
   ```

2. Check status to show what will be committed:
   ```bash
   git status --short
   ```

3. Commit with descriptive message:
   ```bash
   git commit -m "Initial commit: [project description based on context]"
   ```

### Phase 4: Create GitHub Repository

1. Confirm settings with user (defaults below):
   - **Owner:** `Deruk0`
   - **Repo name:** `ShotShorts`
   - **Visibility:** public

   ```
   Create repository Deruk0/ShotShorts (public)? [Y/n]
   ```

2. Create the repo:
   ```bash
   gh repo create Deruk0/ShotShorts --public --source=. --remote=origin --push
   ```

   **Alternative (two-step)** if above fails:
   ```bash
   gh repo create Deruk0/ShotShorts --public --confirm
   git remote add origin https://github.com/Deruk0/ShotShorts.git
   git push -u origin main
   ```

### Phase 5: Verify & Output

1. Verify push succeeded:
   ```bash
   git log --oneline -3
   ```

2. Show the repo URL:
   ```bash
   gh repo view --web
   ```

3. Output success message:
   ```
   Successfully pushed to GitHub!
   Repository: https://github.com/<owner>/<repo>
   Branch: main
   Commits: 1
   ```

## Error Handling

| Error | Solution |
|-------|----------|
| `git` not found | Install git, guide user |
| `gh` not found | Install gh CLI, guide user |
| Not authenticated | Run `gh auth login` |
| Remote already exists | Skip creation, just push |
| Branch name conflict | Use `--force` or rename branch |
| Large files detected | Warn about file size limits |
| `.gitignore` missing | Create basic one, ask to confirm |

## Quick Commands Reference

```bash
# Auth
gh auth login
gh auth status

# Create & push in one command
gh repo create <name> --public --source=. --remote=origin --push

# View repo
gh repo view
gh repo view --web

# Update after initial push
git add -A && git commit -m "message" && git push
```

## Anti-Patterns

- Don't push without confirming repo name and visibility
- Don't skip `.gitignore` check (avoid committing secrets/node_modules)
- Don't use generic "Initial commit" — add project context
- Don't assume user is authenticated on GitHub
- Don't push to existing repo without explicit confirmation

## Decision Tree

```
User says: "push to github"
    ↓
Check: git installed? → No → Install
    ↓ Yes
Check: gh installed? → No → Install
    ↓ Yes
Check: gh authenticated? → No → Login
    ↓ Yes
Check: git repo exists? → No → git init
    ↓ Yes
Check: .gitignore exists? → No → Create
    ↓ Yes
git add -A → git status → Confirm files
    ↓
git commit -m "Initial commit: <project>"
    ↓
Ask: repo name + visibility
    ↓
gh repo create → push
    ↓
Show URL + success message
```
