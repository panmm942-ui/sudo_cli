# Chat commands

Use `/chat` to manage saved conversations in the current project. It works in the offline shell before you choose an AI.

| Command | Result |
| --- | --- |
| `/chat` | List saved chats and choose one by number or ID. Enter cancels the selection. |
| `/chat list` | List saved chats without opening one. |
| `/chat open CHAT_ID` | Restore the selected chat and its visible conversation. |
| `/chat new` or `/new` | Ask whether to keep the current saved chat, then start a fresh conversation. |
| `/chat save` | Save the latest visible history and retained AI context immediately. |
| `/clear` | Clear this chat display; choose whether to forget earlier AI context. Enter keeps context. |
| `/chat rename TITLE` | Rename the current chat. Omit the title to enter it interactively. |
| `/chat delete CHAT_ID` | Confirm deletion of a saved chat. Start or open another chat before deleting the current one. |

Starting a new chat asks `Keep the current saved chat? [Y/n]`. Enter, `y` or `yes` keeps the previous saved conversation; `n` or `no` deletes its saved record. A successful new chat gets a new ID, clears the visible conversation area and starts fresh AI context. Keeping the previous chat lets you restore it later with `/chat open CHAT_ID`.

Canceling the keep question leaves the current chat and visible conversation in place. A storage failure also prevents the screen reset. The reset happens only after the new chat has been created successfully.

Opening a saved chat restores its current visible messages, assistant model attribution, partial replies and queued text. Earlier messages retained with `/clear` No stay hidden from the display but remain context for the next prompt. Credentials and live tool execution state are not restored. See [Saved chats](chats.md) for storage and recovery details.

`/clear` clears and saves the visible messages of the same chat, then applies your choice: **Yes** forgets earlier AI context; **No** or Enter keeps it, including after reopening. The chat ID, title and prompt counter remain unchanged. Canceling preserves the chat. `/history clear` remains a visible-history action without resetting the active engine. `/new` creates a separate chat and asks whether to keep the previous one. Approved project memory and existing export files are unaffected.

## Transition callback

The assistant command handler calls `onChatChange({reason, record})` after a successful chat transition. `reason` is `new` for `/new` and `/chat new`, `open` for a saved-chat selection, or `clear` for `/clear`. The clear transition also supplies the explicit `forget` choice. `record` is the saved record returned by the chat session. The UI uses this distinction to show an empty conversation for a new chat or hydrate the saved history for an opened chat. Cancellation or a failure before the clear is saved does not invoke this callback. If clearing has already been saved but saving newly arriving input fails, the callback updates the display and native context before reporting the save warning; the newly accepted input stays available for another checkpoint.
