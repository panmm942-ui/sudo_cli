# Chat commands

Use `/chat` to manage saved conversations in the current project. It works in the offline shell before you choose an AI.

| Command | Result |
| --- | --- |
| `/chat` | List saved chats and choose one by number or ID. Enter cancels the selection. |
| `/chat list` | List saved chats without opening one. |
| `/chat open CHAT_ID` | Restore the selected chat and its visible conversation. |
| `/chat new` or `/new` | Ask whether to keep the current saved chat, then start a fresh conversation. |
| `/chat save` | Save the latest visible history immediately. |
| `/chat rename TITLE` | Rename the current chat. Omit the title to enter it interactively. |
| `/chat delete CHAT_ID` | Confirm deletion of a saved chat. Start or open another chat before deleting the current one. |

Starting a new chat asks `Keep the current saved chat? [Y/n]`. Enter, `y` or `yes` keeps the previous saved conversation; `n` or `no` deletes its saved record. A successful new chat gets a new ID, clears the visible conversation area and starts fresh AI context. Keeping the previous chat lets you restore it later with `/chat open CHAT_ID`.

Canceling the keep question leaves the current chat and visible conversation in place. A storage failure also prevents the screen reset. The reset happens only after the new chat has been created successfully.

Opening a saved chat restores its visible messages, assistant model attribution, partial replies and queued text. Its conversation becomes context for the next prompt. Credentials and live tool execution state are not restored. See [Saved chats](chats.md) for storage and recovery details.

`/history clear` clears and saves the visible history of the current chat. `/clear` starts fresh AI context while keeping the current visible history. `/new` creates a separate chat and asks whether to keep the previous one.

## Transition callback

The assistant command handler calls `onChatChange({reason, record})` after a successful chat transition. `reason` is `new` for `/new` and `/chat new`, or `open` for a saved-chat selection. `record` is the saved record returned by the chat session. The UI uses this distinction to show an empty conversation for a new chat or hydrate the saved history for an opened chat. A canceled question or failed session operation never invokes this callback.
