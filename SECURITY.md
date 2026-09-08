# Security

Wayfarer is an early development client. Use trusted universes and keep backups
of worlds and local projects. Only the latest published alpha receives fixes;
there is no support SLA or promise that all legacy content is safe to load.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/melkordoran/Wayfarer/security/advisories/new).
Do not put exploitable details, credentials, private addresses, object-path
tokens, private messages, server databases, or complete QA profiles in public
issues. If private reporting is unavailable, open an issue asking for a private
contact channel without including the vulnerability details.

Include the exact version, operating system, offline/local/remote context, a
minimal original reproducer, and the impact. Share only assets you may legally
redistribute. Coordinated disclosure is appreciated.

## Important boundaries

- The renderer is sandboxed with context isolation and a narrow IPC surface.
  Asset requests and archive/parser work have validation and resource limits;
  those measures are not a formal security audit or a total memory bound.
- Use certificate-validated TLS for remote deployments. Legacy transport exists
  for compatibility and is not presented as modern transport security.
- Local project files, downloaded caches and the saved telegram inbox are not
  encrypted at rest. Do not share a profile or the `.runtime` directory.
- Sample fixture accounts and the loopback-only TLS test key are deliberately
  public test material. Never reuse them for an internet-facing deployment.
- World changes are not server transactions. Back up important content; do not
  automatically retry uncertain writes.
- Development previews and optional Axis fixtures bind to loopback. Do not
  expose their ports, credentials or files to untrusted networks.
- macOS alpha builds are ad-hoc signed, not Developer ID signed or notarized.
  Verify the release checksums and source before deciding whether to run them.

See [compatibility limits](docs/compatibility.md) and
[third-party notices](THIRD_PARTY_NOTICES.md).
