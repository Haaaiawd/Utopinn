// Renderer seam — React side of the conversationRenderer contract
// (.loom/design/conversation-renderers.md, packages/protocol/src/renderers.ts).
//
// The protocol's `ConversationRenderer` is an imperative lifecycle
// (init/mount/renderMessage/onDelta/…/dispose) for plugin renderers running
// in the host trust domain. In-app builtin renderers are React components;
// this prop shape is the same contract in component form: the host supplies
// the whole ConversationView + action callbacks, the renderer only draws.
// A plugin renderer gets adapted to this prop surface by a mount shim
// (TASK-011 territory), keeping one host code path.
import type { ComponentType } from 'react';
import type { ConversationView, RendererActions } from '@utopinn/protocol';

export interface ConversationRendererProps {
    /** Host-supplied visible window. The renderer must not reorder messages. */
    view: ConversationView;
    /** Semantics live in the host; the renderer invokes these, never implements them. */
    actions: RendererActions;
}

export type ConversationRendererComponent = ComponentType<ConversationRendererProps>;
