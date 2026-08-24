# Push the Zapier folder to GitHub

## Step 0 — unzip

`Zapier-Day8-11.zip` is in your `Day 8-11 (Zaiper)` folder. Right-click → **Extract All** into that same folder, so you end up with:

```
Day 8-11 (Zaiper)\Zapier\
```

The extracted `Zapier/` folder is **already a git repository** with one commit in it, authored as **Umair Ashraf <umair.ashrafx@gmail.com>**. You only need to create the remote and push.

---

## If you want a repo just for this task

```bash
cd "C:\Users\m_uma\Desktop\AI-Automation-Internship\Day 8-11 (Zaiper)\Zapier"

# create the repo on GitHub and push in one step (GitHub CLI)
gh repo create AI-Automation-Internship --public --source=. --remote=origin --push
```

If you don't have `gh`, create an empty repo at <https://github.com/new> (no README, no .gitignore — the folder already has one), then:

```bash
git branch -M main
git remote add origin https://github.com/<your-username>/AI-Automation-Internship.git
git push -u origin main
```

**Submit this link:**
`https://github.com/<your-username>/AI-Automation-Internship`

---

## If you already have an internship repo and want `Zapier/` inside it

The task says *"under Zapier Folder"*, so this is the version that matches most literally.

```bash
# 1. go to your existing internship repo
cd path/to/AI-Automation-Internship

# 2. copy the folder in (do NOT copy Zapier/.git — you want one repo, not two)
#    Windows PowerShell:
Copy-Item -Recurse "C:\Users\m_uma\Desktop\AI-Automation-Internship\Day 8-11 (Zaiper)\Zapier" .
Remove-Item -Recurse -Force .\Zapier\.git

# 3. commit and push
git add Zapier
git commit -m "Add Day 8-11 Zapier task: 9 modules with code, prompts and schemas"
git push
```

**Submit this link:**
`https://github.com/<your-username>/AI-Automation-Internship/tree/main/Zapier`

---

## Before you submit

- [ ] Build the modules in your own Zapier account, following each module README
- [ ] Screenshot each one — form, table, Zap editor, and a successful test run
- [ ] Drop the screenshots into `Zapier/assets/screenshots/` (naming guide is in that folder's README)
- [ ] Link them from the module READMEs: `![Lead intake form](../assets/screenshots/01-lead-intake-form.png)`
- [ ] Commit and push again
- [ ] Open the link in a private browser window to confirm it's public and readable

The screenshots are the part reviewers look at first — the code and docs prove you understood the design, the screenshots prove you actually built it.

---

## Sanity checks

```bash
# confirm the commit is there and authored correctly
git log --format="%an <%ae>%n%s"

# confirm nothing sensitive is tracked (should return nothing)
git ls-files | grep -Ei "\.env|credential|secret|\.key"

# confirm the remote
git remote -v
```
