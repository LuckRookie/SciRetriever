# MinerU 3.4.4 protocol-2 adapter fixtures

These files are de-identified, offline fixtures for the Parsing-owned
operator-service boundary.  `health.json`, `task-sequence.json`, and
`submit-fields.json` are the closed wire values consumed by the concrete
protocol-2 client.  Tests prove that wire `version`/`protocol_version`/`status`
are converted to neutral `release`/`api_protocol`/`state` values before they
reach `MinerUServicePort`.

The `document_*` files model the selected `vlm-engine` archive profile.  The
test suite builds a ZIP in memory, treats every member as untrusted input, and
verifies that only normalized Markdown plus actually referenced resources
survive conversion.
