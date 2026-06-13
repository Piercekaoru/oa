# config.toml

`config.toml` is a hand-friendly config file at `~/.openachieve/agent/config.toml`. It is the easiest way to wire up a third-party relay/proxy endpoint (中转站) and set a few common preferences in one place.

It is fully optional and layers on top of the existing JSON config: `settings.json`, `models.json`, and `auth.json` all keep working. Anything you can express here you can also express in those files — `config.toml` just gives you a terser syntax and one file to edit.

## Table of Contents

- [Quickstart: a relay endpoint](#quickstart-a-relay-endpoint)
- [`[settings]`](#settings)
- [`[providers.*]`](#providers)
- [Model shorthand vs full tables](#model-shorthand-vs-full-tables)
- [API key resolution](#api-key-resolution)
- [Precedence and compatibility](#precedence-and-compatibility)

## Quickstart: a relay endpoint

A relay station is an OpenAI- or Anthropic-compatible endpoint with a custom base URL and key. The whole setup can be a single block:

```toml
[providers.my-relay]
baseUrl = "https://api.relay.com/v1"
api = "openai-completions"            # or "anthropic-messages"
apiKey = "sk-xxxxxx"
models = ["gpt-4o", "claude-3-5-sonnet", "deepseek-chat"]
```

Start `oa`, open `/model`, and the relay's models appear. Every field other than `id` is filled with sensible defaults (see [Model shorthand](#model-shorthand-vs-full-tables)).

To make one of them the default model on startup, add a `[settings]` block:

```toml
[settings]
defaultModel = "my-relay/gpt-4o"
```

## `[settings]`

Keys under `[settings]` map 1:1 to the fields documented in [Settings](settings.md) (same names, camelCase). Common ones:

```toml
[settings]
defaultModel = "my-relay/gpt-4o"      # same syntax as the --model flag
defaultProvider = "my-relay"
defaultThinkingLevel = "medium"        # off | minimal | low | medium | high | xhigh
theme = "dark"
```

`config.toml` is read-only — the agent never writes to it. When you change a setting from inside the app (for example, switching theme), that change is written to `settings.json`, not here. Unknown keys are ignored, matching `settings.json` behavior.

## `[providers.*]`

Each `[providers.<name>]` block defines (or overrides) a provider. The fields are identical to a provider entry in [`models.json`](models.md#provider-configuration):

| Field | Description |
|-------|-------------|
| `baseUrl` | API endpoint URL |
| `api` | `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai` |
| `apiKey` | API key (see [resolution](#api-key-resolution)) |
| `headers` | Custom request headers |
| `authHeader` | Set `true` to add `Authorization: Bearer <apiKey>` automatically |
| `compat` | Compatibility overrides — see the [OpenAI](models.md#openai-compatibility) and [Anthropic](models.md#anthropic-messages-compatibility) compat tables |
| `models` | List of models — string ids or full tables |

You can also override a built-in provider's base URL (e.g. route Anthropic through a proxy) by naming a built-in provider and omitting `models`:

```toml
[providers.anthropic]
baseUrl = "https://my-proxy.example.com/v1"
```

## Model shorthand vs full tables

For a relay you usually only need ids. The string-array shorthand expands each entry to `{ id = "..." }` with defaults applied:

```toml
[providers.my-relay]
baseUrl = "https://api.relay.com/v1"
api = "openai-completions"
apiKey = "sk-xxxxxx"
models = ["gpt-4o", "deepseek-chat"]
```

Defaults: `name` = `id`, `reasoning` = `false`, `input` = `["text"]`, `contextWindow` = `128000`, `maxTokens` = `16384`, `cost` = all zeros.

When you need precise control, use full tables (`[[providers.<name>.models]]`). The fields match the [Model Configuration](models.md#model-configuration) reference. You can mix both forms in one list:

```toml
[providers.my-relay]
baseUrl = "https://api.relay.com/v1"
api = "anthropic-messages"
apiKey = "sk-xxxxxx"

[[providers.my-relay.models]]
id = "claude-sonnet"
reasoning = true
contextWindow = 200000
input = ["text", "image"]

[[providers.my-relay.models]]
id = "claude-haiku"
```

## API key resolution

`apiKey` and `headers` values support the same resolution as `models.json` (see [Value Resolution](models.md#value-resolution)):

```toml
apiKey = "sk-xxxxxx"                    # literal
apiKey = "$RELAY_API_KEY"               # environment variable
apiKey = "!op read 'op://vault/relay/key'"   # shell command (stdout)
```

You can still keep keys out of the file entirely by logging in with `oa` or setting the provider's environment variable / `auth.json` entry — those are consulted as usual.

## Precedence and compatibility

`config.toml` merges with the existing JSON config rather than replacing it.

- **Settings** (low → high): built-in defaults ◁ `settings.json` (global) ◁ `config.toml [settings]` ◁ project `.openachieve/settings.json`.
- **Providers/models** (low → high): built-in models ◁ `models.json` providers ◁ `config.toml [providers]`. If the same provider name appears in both `models.json` and `config.toml`, the `config.toml` definition wins (the whole provider block is replaced).

If `config.toml` cannot be parsed, the error is shown at startup and the rest of your configuration (including built-in models) keeps working.
