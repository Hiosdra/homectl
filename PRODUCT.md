# Product
<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
Bun and TypeScript CLI/backend. User chose Bun's built-in server and a small HTML/CSS/TypeScript frontend without an additional framework for the first panel.

## Users
A homelab owner who operates the same SSH machines from Linux, native Windows (PowerShell, CMD, Git Bash), and WSL, directly or through coding agents.

## Product Purpose
homectl keeps named machines, access policy, SSH credentials and trusted host fingerprints available across the owner's computers. Successful use means secure access without repeating enrollment, understandable pairing, and explicit resolution of conflicting edits.

## Operating Context
KeePassXC encrypted databases, OpenSSH, local network pairing and peer-to-peer synchronization. `homectl serve` offers a local browser panel either temporarily or as an installed service. PowerShell, CMD and Git Bash share one Windows installation; WSL is a separate peer.

## Capabilities and Constraints
Requested work: native Windows support, mDNS discovery during pairing, one-time code with confirmation on both computers, persistent peer trust, bidirectional synchronization with choose-local/choose-remote/keep-both conflicts, and optional operations through paired peers. These are implementation targets, not claims of deployed behavior. Sessions and filesystem paths remain local. Pairing and passwords must never be included in agent chat or logs. Synchronization and remote operation grants are separate. Existing access policies and remote host-key verification remain binding.

## Evidence on Hand
Existing CLI source, tests, inventory schema and KeePassXC session model. No existing graphical interface or verified Windows runtime evidence. Preserve user edits in shared skills.

## Product Principles
- Peer relationships are symmetric; neither computer is a permanent primary.
- Discoverability does not grant trust.
- Conflicts require an understandable choice rather than silent overwrites.
- Secrets stay encrypted at rest and travel only over authenticated encryption.
- Every operation identifies its target and execution peer.

## Brand Commitments
The user explicitly chose a modern dark application UI entirely in English. User-entered machine names and descriptions are preserved.

## Open Decisions
The standing workflow default for future promotional pages is unanswered and will not be stored. This application panel is built directly in code.
