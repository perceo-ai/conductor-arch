We need to integrate claude code and codex. However, the main selling point of Archductor is that it allows you to run multiple in parallel in one workspace and that it lets you switch between them, modify params, and everything straight from the Archductor GUI. We have the basis for this in terms of UI and the ability to create workspaces, but not much else.

Thus, we have to somewhat copy their harnesses (which are not publicly exposed). These harnesses send inputs to the claude code/codex terminals in the back, allow them to make changes, coordinate git checkpoints for the last turns to display the last turn diffs, prettify the output (including reading skills and tool use), and more. Write a comprehensive plan to build both harnesses and then use subagent driven development to actually go build them. Make sure you test them and make sure they work well and I need both to support everything Archductor supports:
Control Claude Code Codex Cursor
Plan Mode Supported Supported Not supported
Fast Mode Supported Supported Not supported
Thinking or reasoning level Supported when the selected model exposes it Supported when the selected model exposes it Not supported
Personalities Not supported Supported Not supported
Goals Not supported Supported in local workspaces Not supported
Checkpoints Supported Supported Not supported
Skills Supported Supported Not supported

We don't need Cursor integration because they don't even support it well anyways.
