import { For, Show, createResource, createSignal } from "solid-js";
import { send } from "@/bridge/client";
import type { ArchcarProjectionImage } from "@/bridge/protocol";

// Images a tool result carried, drawn in the timeline where the card sits.
//
// The projection only names them: a screenshot is a megabyte of base64, and
// the timeline is re-fetched on every streamed token, so the bytes ride a
// separate request per image. Small ones load as soon as the card renders —
// the point is to see what the agent saw without asking. A large one waits for
// a click, so opening an old chat full of screenshots does not pull tens of
// megabytes through the socket at once.

/** Decoded size above which an image loads only when asked for. */
export const AUTOLOAD_BYTE_LIMIT = 2 * 1024 * 1024;

/** Size as a reader would say it, for the button that defers a big image. */
export function formatImageSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

async function fetchImage(req: { threadId: number; itemId: string; index: number }): Promise<string> {
  const res = await send({
    type: "get_chat_image",
    thread_id: req.threadId,
    item_id: req.itemId,
    index: req.index,
  });
  if (res.type === "chat_image") return `data:${res.media_type};base64,${res.data}`;
  throw new Error(res.type === "error" ? res.message : "Unexpected response");
}

function ChatImage(props: {
  threadId: number;
  itemId: string;
  index: number;
  image: ArchcarProjectionImage;
}) {
  const [wanted, setWanted] = createSignal(props.image.bytes <= AUTOLOAD_BYTE_LIMIT);
  const [full, setFull] = createSignal(false);
  const [source] = createResource(
    () => (wanted() ? { threadId: props.threadId, itemId: props.itemId, index: props.index } : undefined),
    fetchImage,
  );
  return (
    <Show
      when={wanted()}
      fallback={
        <button class="chat-image-deferred" onClick={() => setWanted(true)}>
          Show image ({formatImageSize(props.image.bytes)})
        </button>
      }
    >
      <Show when={source.error}>
        <span class="chat-image-error">Image unavailable: {(source.error as Error).message}</span>
      </Show>
      <Show when={source()}>
        {(src) => (
          // Click toggles between the thumbnail the timeline can hold and the
          // image at its own size, which is what a screenshot of a UI needs.
          <img
            class="chat-image"
            classList={{ "chat-image-full": full() }}
            src={src()}
            alt={`${props.image.media_type} the agent read`}
            title={full() ? "Click to shrink" : "Click to enlarge"}
            onClick={() => setFull((shown) => !shown)}
          />
        )}
      </Show>
    </Show>
  );
}

export default function ChatImages(props: {
  threadId: number;
  itemId: string;
  images: readonly ArchcarProjectionImage[];
}) {
  return (
    <div class="chat-image-strip">
      <For each={props.images}>
        {(image, index) => (
          <ChatImage threadId={props.threadId} itemId={props.itemId} index={index()} image={image} />
        )}
      </For>
    </div>
  );
}
