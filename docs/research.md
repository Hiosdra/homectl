# Primary sources and implementation choices

| Area | Primary source | Choice |
| --- | --- | --- |
| KeePassXC CLI | [Official CLI manual](https://github.com/keepassxreboot/keepassxc/blob/2.7.10/docs/man/keepassxc-cli.1.adoc) | KDBX creation, private password input, key attachments and export to private pipes |
| Dedicated SSH agent | [OpenSSH ssh-agent](https://man.openbsd.org/ssh-agent), [ssh-add](https://man.openbsd.org/ssh-add) | Dedicated socket, timed keys, lock without changing the personal agent |
| SSH identity/trust | [OpenSSH ssh_config](https://man.openbsd.org/ssh_config) | Public IdentityFile, IdentityAgent, strict host keys, no forwarding or password authentication |
| Proxmox SSH API | [Official pvesh source](https://github.com/proxmox/pve-manager/blob/master/PVE/CLI/pvesh.pm) | Node-local get/create/set, --noproxy and JSON output through SSH |
| Proxmox cloud-init keys | [Official QEMU schema](https://github.com/proxmox/qemu-server/blob/master/src/PVE/QemuServer.pm) | URL-encode sshkeys explicitly when invoking pvesh |
| UGREEN homes | [Official SSH guide](https://ai.ugreen.com/blogs/how-to/connect-nas-ssh-root-access) | Enable Personal Folder through UGOS before installing a user key |
| Bun processes | [Official subprocess documentation](https://bun.sh/docs/api/spawn) | Separate workers and explicit pipes/argv |

The KeePassXC manual documents `attachment-export --stdout`; CLI quiet mode suppresses prompts while attachment bytes remain privately captured. Passwords go through private stdin, never command arguments or agent-visible results. Initial creation and key editing require private user invocation.

OpenSSH lifetime applies to keys used for new authentication. It does not terminate established sessions. The homectl supervisor additionally enforces absolute session expiry. KDBX is not an always-open service; its password is not cached by the supervisor.

The official pvesh implementation documents and implements `--noproxy`, method mapping and `--output-format json`. This avoids a second credential lifecycle for Proxmox. The full/root tier still means broad host privileges; the scoped adapter supports only the provisioning paths it needs.

Operational evidence must distinguish static validation, fixture tests, actual SSH access and actual VM creation. No source or fake test establishes that a particular template, node ACL or storage is ready. Consult the node's installed `pvesh` help/API schema before first real provisioning.
