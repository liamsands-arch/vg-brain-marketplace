# VG Brain — plugin marketplace

Public, **secret-less** Claude Code / Cowork marketplace for Voyageur Group's
VG Brain plugin. Contains no tokens, no `.env`, no server source — just the
plugin shell. Authentication is OAuth: `mcp-remote` runs the handshake against
`https://vg-brain.com` and caches the token locally; the session hooks read it
from that cache at runtime.

## Add it

In Cowork → **Add marketplace** → enter `liamsands-arch/vg-brain-marketplace`
(or the repo URL). Then install the **vg-brain** plugin and restart.

First connect triggers a Google sign-in (the `@voyageurgroup.co` domain claim
auto-joins you to the tenant) and issues a ~30-day token. No bearer is ever
copied or pasted.

## Contents

- `.claude-plugin/marketplace.json` — marketplace manifest
- `plugins/vg-brain/` — the plugin: `.claude-plugin/plugin.json`, secret-less
  `.mcp.json`, `hooks/` (SessionStart/SessionEnd/PreCompact), `output-styles/`

_Generated from the vg-brain bundler's compiled assets; do not hand-edit the
hook scripts here — change them in the vg-brain repo and regenerate._
