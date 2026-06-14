# Deploy

Deploy to enpitech using enpitech CLI.

## Parameters

- {path-to-project} is the path to the project directory. It is relative to the current working directory.
- When executing a command requiring `{path-to-project}`, check that you provided the correct path to the project.

## Steps

1. **Make sure the user is logged in to enpitech**

Execute `npx enpitech@latest login` to login to enpitech.

2. **Deploy to enpitech**

If it's a first time deployment (absence of `.enpitech/` folder in the project directory), **ask the user for the project name**.
Then, execute `npx enpitech@latest deploy --yes --project-name {project-name} {path-to-project}`.

3. **Subsequent deployments**

For subsequent deployments (presence of `.enpitech/` folder in the project directory), execute `npx enpitech@latest deploy --yes {path-to-project}`.

4. **Setup GitHub integration**

If it's a new project, ask the user first if they want to setup git.
If yes:

- **Push to GitHub** — Commit and push code
- **Link to enpitech project** - Use `npx enpitech@latest git connect --yes {path-to-project}`

Full docs: [docs.enpitech.dev/quickstart](https://docs.enpitech.dev/quickstart)
