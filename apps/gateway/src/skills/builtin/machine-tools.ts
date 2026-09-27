import type { Skill } from '@jian/contracts';

export const machineTools: Skill = {
  name: 'machine-tools',
  description:
    'Use before running commands or installing anything: what the machine has, how to install more without root, logins and keys, and the limits of a command.',
  instructions: `# The machine you run commands on

Commands run with \`run_command\`, in the \`shell\` tool group: load it with \`load_tools\`
first. They run on the machine the gateway runs on, as whoever started it. There is no
sandbox.

A command does not inherit the gateway's environment: it gets \`PATH\`, \`HOME\`, the locale
and a few install paths, and nothing else — no \`DATABASE_URL\`, no \`NODE_ENV\`, no keys.
When a project needs a variable, set it in the command itself. Point database tests at a
database made for them, never at the gateway's own.

Check where you are: \`echo $JIAN_TOOLBOX\`. If it prints \`1\` you are in the Jian image and
what follows holds. Otherwise the gateway runs directly on the owner's machine: find what
exists with \`command -v <tool>\`, and install nothing there unless the owner asks.

## Already installed in the image

- Runtimes: Node 24 with npm, pnpm and yarn (through corepack); Python 3 with pip, venv and
  \`uv\`/\`uvx\`; Go.
- Git and the network: \`git\`, \`gh\`, \`ssh\`, \`scp\`, \`curl\`, \`wget\`, \`rsync\`.
- Text: \`rg\` (ripgrep), \`fd\`, \`jq\`, \`sed\`, \`awk\`, \`grep\`, \`diff\`, \`patch\`, \`tree\`,
  \`file\`, \`less\`, \`nano\`, \`vi\`.
- Archives: \`tar\`, \`zip\`/\`unzip\`, \`xz\`, \`bzip2\`, \`zstd\`.
- Builds: \`gcc\`, \`g++\`, \`make\`, \`pkg-config\`.
- Diagnosis: \`ps\`, \`kill\`, \`lsof\`, \`ip\`, \`ping\`, \`dig\`, \`nc\`.
- Data and media: \`sqlite3\`, \`psql\`, \`ffmpeg\`.

## Installing more

You are the user \`node\`, without root and without \`sudo\`. Everything under \`/home/node\`
lives on a volume that survives a new image, so install there:

- Node: \`npm install -g <pkg>\` (lands in \`~/.local\`).
- Python tools: \`uv tool install <pkg>\`. A project: \`uv venv\`, then \`uv pip install\`. A
  bare \`pip install\` is refused by the system Python.
- Go: \`go install <module>@latest\` (lands in \`~/go/bin\`).
- A single binary: download it to \`~/.local/bin\` and \`chmod +x\` it.

There is no \`apt\`. When a task needs a system package, look for a static binary or a
per-user build first; if there is none, tell the owner which package, so it can be added to
the image. Install what the task needs, not what might be handy, and say what you installed.

## Logins and keys

- \`gh\` needs a token: \`gh auth login --with-token\` with one the owner gives you, or
  \`GH_TOKEN\` in the command's environment.
- SSH keys go in \`~/.ssh\` with mode \`600\`.
- Git needs \`git config --global user.name\` and \`user.email\` before a commit.

All of them persist in the home volume. Never print a token, a password or a private key
into the conversation, and never send one anywhere the owner did not ask.

## Limits of a command

- A command stops after at most two minutes (\`timeoutMs\`, 30 seconds unless you raise it).
- Output past about 60,000 characters is cut.
- A long job: split it into steps, or start it in the background writing to a log file, and
  read the log afterwards.

## Before you run something

Say what you are about to do when it changes anything. Never run something destructive — a
delete, an overwrite, a force-push, a migration — that nobody in this conversation asked
for. A command can be held back by the Decisions check; the answer tells you why. Then ask
the owner to confirm that exact action, and do not try to reach the same effect another way.

For reading and changing code, load the \`coding-work\` skill.`,
};
