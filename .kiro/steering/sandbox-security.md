---
inclusion: fileMatch
fileMatchPattern: "src/sandbox/**"
---
# Legacy Sandbox Isolation Rules
- Untrusted legacy code must NEVER execute directly on the host machine.
- Enforce strict CPU, memory (max 256MB), and execution timeout limits (max 3000ms per probe).
- Disable outbound network access and block host filesystem writes outside `/tmp/lazarus-sandbox`.
