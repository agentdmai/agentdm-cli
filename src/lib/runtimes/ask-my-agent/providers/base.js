// Provider strategy interface.
//
// A provider exposes a single async-generator method:
//
//   chat(messages, tools) → AsyncIterator<ChatEvent>
//
// where each yielded event is one of:
//   { type: "token", delta: "<text>" }
//   { type: "tool_call", tool_call: { name, args } }
//   { type: "done" }
//   { type: "error", message: "<text>" }
//
// Concrete strategies (Anthropic, OpenAI, HuggingFace, …) do NOT inherit
// from this class. They implement the same shape; duck typing is enough.
// This file exists as the readable contract; the runtime imports nothing
// from it at runtime.

export class BaseProvider {
  // eslint-disable-next-line no-unused-vars
  constructor({ model }) {
    this.model = model;
  }

  // eslint-disable-next-line no-unused-vars, require-yield
  async *chat(_messages, _tools) {
    throw new Error('chat() not implemented');
  }
}
