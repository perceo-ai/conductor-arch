# Composer inline chips

Replace the chat composer's textarea-plus-markdown-overlay with a single
rich input, in which `@file` mentions and `/commands` are atomic chips.

## Why

The composer stacks two elements in one grid cell: a `.chat-input-render`
div holding markdown-rendered HTML, and a `.chat-input-view` textarea whose
glyphs are hidden with `color: transparent` whenever it has content. You
type into the textarea and read the div.

Two layers cannot be kept in step, and they are not:

| | `.chat-input-render` | `.chat-input-view` |
| --- | --- | --- |
| font-size | 14px | 13px |
| line-height | 21.7px | 18.85px |
| padding | 10px 12px | 0 |

The caret sits at the box edge while the glyphs start 12px right and 10px
down, and the 14-vs-13px advance widens the gap along the line. The drift
came from five later style passes restyling the textarea and addressing its
twin as `.chat-input-view text` — a selector for an SVG `<text>` descendant,
which matches nothing. `.chat-input-render` is styled in exactly one file
and never received any of it.

Aligning the two layers would not fix the class of bug, only this instance.
Markdown rendering changes the character stream by design: `**bold**` is
eight characters in the textarea and four glyphs in the overlay, so the
caret and the text it is supposedly inside diverge as soon as any syntax is
typed. The overlay approach cannot be made correct.

The preview is also not wanted. What is wanted is that `@file` and
`/command` read as the first-class concepts they are — which the overlay
achieves today only as an illusion painted over a plain string.

## Approach

A `contenteditable` div holding text nodes interleaved with
`contenteditable="false"` chip spans. Caret and glyphs become the same DOM
node, so the misalignment is not fixed but made unrepresentable.

Chip atomicity — arrow keys stepping over a chip, one Backspace removing
the whole thing — is what `contenteditable="false"` already does. The
composer currently hand-rolls that behaviour against the flat string in
`removeAdjacentAttachmentMarker`, which this change deletes rather than
ports.

Rejected: ProseMirror or Lexical (100-150kB gzipped onto a 79kB bundle and
a schema layer for one input box) and CodeMirror 6 (a code editor whose
selection, wrapping and keymap defaults would need fighting).

## Model

A composer document is a flat list — the input has no block structure:

```ts
type ComposerNode =
  | { kind: "text"; text: string }
  | { kind: "file"; path: string; label: string }
  | { kind: "command"; name: string };
```

Three pure functions carry it across every boundary, in `lib/composerDocument.ts`:

- `toVisible(nodes)` — the `{foo.ts}` form that is stored and re-rendered in
  history. Unchanged wire format, so `TimelineItem` keeps working untouched.
- `toInput(nodes)` — the `@src/foo.ts` form sent to the agent. Also
  unchanged; this is what `promptTextWithAttachmentRefs` produces today.
- `fromVisible(text)` — parse back to nodes, for draft restore and for
  seeding the composer from elsewhere in the app.

Keeping both serializations identical to today's strings is deliberate: the
daemon, the transcript and the history renderer see no change at all, and
the blast radius stops at the composer.

### Mention detection keeps its string interface

`inlineFileMentionAt` and `skillMentionAt` take `(value, cursor)` and return
character ranges. They are pure, tested, and correct. Rather than rewrite
them against the DOM, the input computes the plain-text prefix before the
caret — walking to the caret's container and summing text lengths, counting
each chip as the length of its visible token — and hands them the same
`(value, cursor)` pair they take now.

So the menus, ranking, and keyboard navigation are untouched by this change.

### Deliberately unchanged

A `/command` stays valid at the start of a line or after whitespace, exactly
as `skillMentionAt` defines it today; it is drawn as a chip rather than
given a new placement rule. Markdown syntax renders as the literal
characters typed — no bold, no code styling — since dropping the preview is
half the point. Sent messages still render markdown with chips in the
timeline, which is `TimelineItem`'s job and is not touched.

## Components

**`lib/composerDocument.ts`** — node types and the three serializers, plus
`nodesFromDom(el)` and `caretOffset(el)`. Everything except the last two is
pure and DOM-free.

**`components/RichInput.tsx`** — the `contenteditable`. Owns:

- rendering nodes to DOM, and doing so *only* on mount, draft restore and
  chip insertion. Re-rendering on every keystroke is what makes
  `contenteditable` implementations jump the caret; between those moments
  the DOM is the source of truth and the signal follows it, not the reverse.
- `beforeinput` for Enter: insert a `\n` text node rather than let the
  browser produce `<div>`/`<br>` soup. `white-space: pre-wrap` renders it.
- `paste`: `preventDefault` and insert `text/plain`, preserving the existing
  large-paste-to-file path.
- `compositionstart`/`compositionend`: suppress mention detection mid-IME,
  or every keystroke of a CJK composition opens the file menu.
- placeholder via `:empty::before { content: attr(data-placeholder) }`.

**`pages/chat/Composer.tsx`** — swaps the textarea and the overlay div for
`RichInput`. `text()` becomes `toVisible(nodes())`. `attachments()` stops
being a parallel signal kept in sync by substring search and becomes derived
from the nodes, which removes the `value.includes(a.marker)` filter in
`buildPayload`.

**Styles** — delete the `.chat-input-render` rules; add chip styling;
delete the five dead `.chat-input-view text` selectors that caused the
drift. `styles/composerPreview.test.ts` guards an overlay that will no
longer exist and goes with it; its bug cannot recur once there is one layer.

## Testing

Pure layer, in `composerDocument.test.ts`: serializer round-trips, chip
token lengths, caret-offset arithmetic across chips, and `fromVisible`
against strings containing braces that are not markers.

DOM layer, in `RichInput.test.tsx` under jsdom: typing appends text, chip
insertion places a node, Backspace after a chip removes the whole chip,
paste inserts plain text, Enter inserts a newline and not an element.
jsdom's `Selection` support is partial, so anything it cannot express is
covered in the Electron smoke instead of faked.

End to end: the Electron smoke recipe, driving the real window — type a
message with a file chip and a command chip, screenshot, and confirm the
caret sits where the glyphs are.

## Known limitation

Programmatic chip insertion may not participate in the browser's native
undo stack, so Cmd-Z after picking a file from the menu may not restore the
typed `@query`. Typing and deletion undo normally. Fixing this properly
means owning an undo stack, which is out of scope here; if it grates in
use, that is the follow-up.
