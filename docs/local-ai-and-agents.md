# Local AI, personalization and agents

Open an Administrator/root terminal. Run:

```text
sudocli
```

The CLI opens without asking for a cloud key. Connect when you are ready.

## Use your installed local AI

Start its model server first.

- **Ollama:** run `ollama serve`.
- **LM Studio:** load your model, then start Local Server.
- **Other:** start its compatible local server, such as llama.cpp or vLLM.

In SUDO CLI, enter:

```text
/local
```

Choose the server. Select your installed model. Give the saved AI a name.

Most local servers need **no key**. Choose **No** when asked about authentication.
Choose **Yes** only if you configured a key on that server.

To return to a saved local AI:

```text
/local My Local AI
```

You need a running compatible model server. A downloaded model file alone is not
enough. SUDO CLI connects to it; it does not install or host its weights.

Local setup accepts `localhost`, `127.0.0.1` and `::1`. A server on another machine
uses `/connect`. A local proxy can still forward requests to a cloud provider;
check what your chosen server does if you want all processing to stay on your PC.

## Give each AI its own personality

Select an AI first. Then use:

```text
/personalize set persona Be a calm coding partner. Explain things clearly.
/preferences set language English
/preferences set tone Friendly and direct
/preferences set length Short
/preferences set format Short paragraphs and simple lists
```

These settings are saved for **that model and endpoint**. Another AI has its own
settings. They return when you switch back.

```text
/personalize status
/preferences status
/personalize off
/personalize on
```

Use `/personalize setup` for a guided questionnaire. These preferences guide
replies; they do not grant permissions or change the model's training.

## Use specialist agents

See the built-in specialists:

```text
/agents list
```

Available roles: **planner, coder, reviewer, tester, security, researcher**.

Ask one specialist:

```text
/agents run reviewer Find bugs in this project
```

Ask a team:

```text
/agents team planner,reviewer Plan this change and review the risks
```

Create your own saved specialist:

```text
/agents add my-reviewer
```

Choose its role, review/edit mode, AI and instructions. You can select a saved AI
or the current AI. The specialist uses that AI's personalization too.

## Plan, code and review together

```text
/agents pipeline Add the feature described in README.md
```

The planner makes a plan. The coder works in a **separate project copy**.
The tester recommends checks. The reviewer examines the proposed copy.

To use your own saved specialists, choose four names in this order:
planner, coder, tester, reviewer.

```text
/agents pipeline --agents my-planner,my-coder,my-tester,my-reviewer Add the feature
```

Your original files stay unchanged until you apply the proposal.

The CLI prints a saved result ID. Replace `ID` below with that value:

```text
/agents diff ID coder
/agents apply ID coder
/verify
```

`apply` preserves files you changed after the copy was made and reports conflicts.
`/verify` runs checks you selected with `/checks`. With no checks, the result stays
**Needs review**. Model reports alone do not prove the work passes tests.

## Progress, stopping and saved results

```text
/agents status
/agents steer reviewer Focus on the login code
/agents stop reviewer
/stop
/agents results
/agents result ID
/agents follow ID reviewer Continue this review
```

`/stop` cancels all current work. Saved specialists and reports survive restart.
Use `steer` while the named agent is working. Its instructions still follow the
selected permissions. Agent reports are supplied as advice to your next main
AI prompt; they do not grant new permissions.

Each agent gets a fresh, bounded source copy. Main chat history is not passed
automatically. Source agents have Web Access and Computer Use **Off**. Each model
request still uses your selected local or cloud AI and its configured limits.

## What was checked

The real Linux terminal, CLI and native engine passed the local AI and agents
acceptance run: **25 streamed model requests and 2 successful CLI exits**.

It checked keyless local connections, separate AI preferences, agent teams,
custom pipelines, coding copies, review, apply, conflicts, selected checks,
report sharing, live guidance, stopping and restart.
The model server was a local test fixture. Real model weights and audio hardware
were not used in that acceptance run.

Developer reproduction: `python3 test/manual/verify-v0.6.1-linux.py` as Linux root,
with Node.js 22+ and the pinned Linux native runtime installed.
