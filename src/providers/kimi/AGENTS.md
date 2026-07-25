# Kimi Provider

`src/providers/kimi/` adapts Kimi CLI through Agent Client Protocol over a `kimi acp` subprocess.

## Ownership

- Kimi process/session lifecycle, ACP request routing, native-history hydration, model catalogs, tool normalization, settings reconciliation, UI, and auxiliary services live here.
- Shared code consumes Kimi only through provider-neutral runtime, capability, registry, and workspace-service contracts.
- Provider-owned conversation data stays behind `KimiProviderState` helpers; feature code must not inspect it.

## Protocol and Session Rules

- Preserve `Conversation.sessionId` and provider state across prompt, CLI-path, and environment changes so Claudian can reload the same native session.
- Use Kimi native history read-only. Never delete or mutate a Kimi session when a Claudian conversation is deleted.
- Send image attachments as ACP image content blocks and rehydrate persisted native blocks.
- Expose Safe, Plan, and YOLO. Plan is a native ACP session mode layered over the remembered Safe or YOLO base; native mode updates remain authoritative.
- Kimi does not currently support rewind, fork, turn steering, or MCP tool wiring through this adapter.

## Models and Settings

- Model selections are `kimi/<raw-id>` in Claudian and raw ids on the ACP wire.
- Catalog snapshots are current-device scoped and contain only normalized non-secret metadata.
- Do not rewrite user-owned native config files or source shell startup files.
