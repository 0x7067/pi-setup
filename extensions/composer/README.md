# Composer

Both Pi modes use this custom editor. It retains Pi's native editing, undo,
history, file and command completion, external editor, and message queue.
Run `/reload` after installation; `/composer` shows the controls.

| Control | Action |
| --- | --- |
| `$` | Find a loaded skill by name or description |
| `@` | Find files, skills, and tools |
| `@skill:` / `@tool:` | Restrict reference search |
| Enter / Tab in a picker | Insert the selection without sending |
| Shift+Enter / Ctrl+J | Newline |
| Alt+S | Stash, restore, or swap the immediate draft |
| Alt+I | Focus the image gallery; arrows select, Enter inspects, Delete removes |
| Backspace | At the start of the text, removes the newest image |
| Click a thumbnail | Selects it; click again to inspect |
| Escape in the image gallery | Return to typing without aborting the agent |
| Alt+P | Expand native paste blocks; undo restores the collapsed form |
| Ctrl+G | Edit the fully expanded draft in the external editor |

The stash is one in-memory slot for this session, not a saved-prompt library.
It retains the native buffer, including cursor, undo, kill ring, and collapsed
paste contents. Stashing clears the editor; restoring into an occupied editor
swaps the two buffers. `/stash` can restore it after a quick question. Reload,
session switch, and exit discard the slot. Nothing is written to disk for stash.
The private adapter in `draft.ts` keeps attachment metadata in Pi's deep-cloned
draft state, alongside native undo and history. It checks the native setter,
paste, and submission hooks at startup. No image path, token, or invisible
marker is inserted into the editable text.

Images appear above the text area, with the cursor immediately below them.
Multiple images form a compact numbered gallery; arrows in image focus reveal
additional images when they do not all fit. Thumbnails use separate rows because
Pi's terminal renderer tracks one image per row. Only visible previews are cached.
The footer stays muted and adapts to the state: discovery hints while empty,
picker keys while a completion list is open, and image or stash controls otherwise.

Image paste uses Pi's existing clipboard handler. Dropping one or more quoted or
escaped image paths also creates attachments, including split paste packets.
Mixed text remains an ordinary native paste. Alt+I then Enter opens a larger
inspection overlay. Image support depends on the complete terminal/tmux path;
unsupported terminals show a compact fallback. Missing, corrupt, or >10 MiB files
show an error without dropping the attachment. Paths are serialized only for
submission, queues, and external editing. Preview sizing never changes the file.

References come from Pi's current catalog, including its project-trust filtering.
`$skill-name` in an interactive prompt includes that skill's instructions and
source directory when sent. Unknown names remain literal. Tool references are
explicit names in the prompt; selecting one never runs or enables a tool.
Shell input and native slash commands are not rewritten as skill references.

## Shift+Enter in Ghostty and tmux

Ghostty only treats Option as Alt by default on U.S. Standard / U.S.
International layouts. On other layouts Option+S sends `ß` instead of
`Alt+S`, so no Alt shortcut reaches Pi. Keep left Option as Alt and right
Option for special characters:

```ini
macos-option-as-alt = left
```

The previous Ghostty mapping `shift+enter=text:\x1b\r` sent **Alt+Enter**, which
Pi correctly treats as queue-follow-up. Use a distinct CSI-u sequence instead:

```ini
keybind = shift+enter=text:\x1b[13;2u
```

Reload Ghostty's configuration after changing it. For tmux 3.5+, use:

```tmux
set -s extended-keys on
set -s extended-keys-format csi-u
```

tmux 3.2–3.4 supports extended keys but not `extended-keys-format`; keep its
default xterm format, which Pi also understands. Do not kill existing tmux
sessions to apply keyboard changes. Verify in a fresh client/pane first.

## Verification

`npm test --workspace pi-composer` runs native-editor behavioral tests, including
stash/restore and swap, gallery geometry and cursor placement, image-only drafts,
image removal/undo and queue serialization, completion
acceptance, newline decoding, history draft retention, preview failures, and
narrow rendering. `npm run test:smoke` verifies both profiles load the extension
without tool or command ownership conflicts.
