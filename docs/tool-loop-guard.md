# Tool-loop guard

The guard stops a task when completed tool calls keep producing the same results without progress. By default, four consecutive repetitions of one action, or four repetitions of a two-action or three-action cycle, block the next model request. The CLI then reports that the task stopped because its tool actions and results repeated. Explicitly change or continue the task before retrying it.

The comparison includes the tool's namespace and name, its arguments, and its completed result. Changed files, command arguments, exit codes or output count as different results. JSON argument objects are compared with sorted keys, while array order remains meaningful. Custom-tool inputs retain their exact text.

For native `exec_command` and `write_stdin`, the comparison ignores top-level `yield_time_ms` and `max_output_tokens`. Recognizable native output headers ignore changing chunk IDs, wall time and original token counts. Exit status, session identity and actual command output remain part of the comparison. Timing-like text inside the command's output is preserved. Structured native result objects receive the same treatment for their wrapper metadata.

The guard compares completed calls with a matching output. A call still waiting for its tool output does not count. Each completed call ID is counted once, even when the full history is replayed repeatedly. The first request seeds IDs already present, so old history cannot immediately block a new human task. Pairs before the latest user message are also excluded.

This is a bounded repetition check rather than proof that a task has made no progress. A deliberately quiet command polled repeatedly with identical results can reach the same limit. The guard does not change a model's decisions or replace provider compatibility, correct reasoning/tool parsers, command timeouts or cancellation. It detects one concrete form of repeated execution before another request is sent.

## Integration

`createToolLoopGuard({enabled:true,repeatLimit:4,maxHistory:10000})` returns `{inspect,reset}`. Call `guard.inspect(request.input)` synchronously with the transient native Responses input before budget admission or upstream model traffic. A disabled guard bypasses inspection. Plain text and missing input are accepted as no-tool requests.

Create a new guard or call `guard.reset()` when a human starts or explicitly resumes a task. A repetition failure remains latched until that reset, so automatic provider retries cannot repeatedly continue the stopped task. The root UI owns the enabled preference and user-facing controls.

The default maximum is 10,000 input items and 10,000 retained call IDs. Serialized input is limited to 16 MiB, IDs and tool names to 256 characters, and normalized nesting to 128 levels. `repeatLimit` accepts integers from 2 through 10; the rolling window retains at most 30 completed-action hashes, enough for a three-action cycle at the maximum limit.

The module throws controlled errors:

- `TOOL_LOOP_REPEATED`: the configured repeated-action threshold was reached.
- `TOOL_LOOP_HISTORY_LIMIT`: input, retained call IDs or nesting exceeded a bound.
- `TOOL_LOOP_INVALID`: a tool ID, arguments shape or history shape was invalid.

No raw arguments, output, identifiers or input arrays are retained. The guard stores SHA-256 hashes, completion flags and bounded recent signature hashes in memory; it does not write any state to disk. Test coverage uses synthetic Responses histories and native output fixtures, without external model requests.
