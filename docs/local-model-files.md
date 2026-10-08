# Connect your local AI file

**Select your file in SUDO CLI. It checks the format and offers a compatible loader.**

Open an **Administrator/root** terminal and run `sudocli`. Enter:

```text
/local file "C:\Models\my-model.gguf"
```

Replace the example path with your own file or model folder.
You can enter **any extension**. Detection checks the file contents; it does not
assume every file can run as an AI.

For supported models, choose your **installed** runner. Most GGUF models offer
Ollama or LM Studio. A GGUF renamed to another extension offers Ollama.
Some complete Safetensors model folders offer Ollama.

Choose **0 — Inspect only** to leave the model unimported. To inspect without an
import menu:

```text
/local info "C:\Models\my-model.gguf"
```

`/local inspect` is an alias for `/local info`.

An Ollama import creates a local model entry and then lets you save its connection.
Keep Ollama's local server running. An LM Studio import **copies** the file;
load the imported model and start its server before using `/local` to connect.
The original model file stays in place.

If the format needs another runner, the CLI explains what is missing. It does not
install runners or download another model. The manual steps below help you
prepare an existing runner.

SUDO CLI delegates model loading to a runner. `/upload` attaches project files to
a conversation; it does not install an AI model.

## 1. Check the file type

| What you have | Next step |
| --- | --- |
| A `.gguf` file | Use the LM Studio or Ollama steps below. |
| Several split `.gguf` files | Keep every shard and its original name. |
| A `.safetensors` model folder | Keep the weights, model configuration and tokenizer together. The runner must support that model's architecture. |
| `adapter_model.safetensors` | This is an adapter. You also need its matching base model and adapter configuration. |
| A `.bin`, `.pt` or other file | Identify its model and format before choosing a runner. Renaming it to `.gguf` does not convert it. |

See [Ollama's import guide](https://docs.ollama.com/import),
[Transformers' local model loading](https://huggingface.co/docs/transformers/model_doc/auto)
and [the PEFT adapter format](https://huggingface.co/docs/peft/main/en/developer_guides/checkpoint).

## 2. A GGUF file with LM Studio

These commands assume LM Studio and its `lms` command are already installed.
Replace the example path with your file's path.

In an ordinary terminal, run:

```text
lms import "C:\Models\my-model.gguf" --copy
lms load
lms server start --port 1234
```

Follow the import prompts. At `lms load`, select your imported model.
`--copy` keeps your original file; an import without it normally moves the file.
On Linux/macOS, use a path such as `"/path/to/my-model.gguf"`.

You can also load the model in LM Studio and start its server in the **Developer**
tab. Keep the server running.

Official instructions: [import](https://lmstudio.ai/docs/cli/local-models/import),
[load](https://lmstudio.ai/docs/cli/local-models/load) and
[start the server](https://lmstudio.ai/docs/cli/serve/server-start).

## 3. Connect inside SUDO CLI

Open an **Administrator/root** terminal and run `sudocli`. Enter:

```text
/local
```

Answer the setup prompts:

1. Choose **2 — LM Studio**.
2. Keep `http://localhost:1234/v1` by pressing **Enter**.
3. Choose **N** for authentication, unless you configured a server key.
4. Select your model number from the list.
5. For context capacity, enter the server's configured token limit, or leave it blank.
6. Save it under a name such as **My Local AI**.
7. Leave supported effort levels blank if you do not know them.

Send a short prompt to check the connection. To select it again later:

```text
/local My Local AI
```

These steps use the CLI's local setup and LM Studio's
[compatible API](https://lmstudio.ai/docs/developer/openai-compat).

## Alternative: a GGUF file with Ollama

If you already use Ollama, create a text file named **Modelfile** beside your
model. For a model named `my-model.gguf`, put this line in it:

```text
FROM ./my-model.gguf
```

In that folder, run:

```text
ollama create my-local-ai -f Modelfile
```

Keep Ollama running. If its server is not running, start `ollama serve` in another
terminal. In SUDO CLI, enter `/local` and choose **1 — Ollama**.
Keep `http://localhost:11434/v1`, choose **N** for authentication and select
`my-local-ai` from the model list.

For split GGUF weights, Ollama's current import guide describes a wildcard such
as `FROM ./model-*.gguf`. For supported Safetensors models, `FROM` points to the
complete model directory. See [importing models](https://docs.ollama.com/import),
[Modelfile paths](https://docs.ollama.com/modelfile),
[server commands](https://docs.ollama.com/cli) and
[local API access](https://docs.ollama.com/api/openai-compatibility).

## If something does not work

- **No models listed:** load the model in the runner and check its server is running.
- **Not enough memory:** choose a smaller model or suitable quantization for your PC.
- **Chat works, but tools do not:** the model and runner must support tool calls.
  A file extension alone does not establish that support. See
  [LM Studio's tool guidance](https://lmstudio.ai/docs/developer/openai-compat/tools).
- **You want processing to stay on your PC:** select your imported local weights.
  A localhost server can also proxy a cloud model.
