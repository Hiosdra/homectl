// Step 3: put the public key on the machine, using access the owner already has.
// The steps differ by platform; each one ends with "Check the path first", because
// a key in the wrong file does nothing and looks like a failure later.
import { type ReactNode, useId, useState } from "react";
import { CopyButton } from "./copy";
import { RadioRow } from "./radio";
import { Notice } from "./ui";

type Platform = "linux" | "ugos" | "proxmox";

const PLATFORMS: { id: Platform; title: string; detail: string }[] = [
  {
    id: "linux",
    title: "A Linux machine, or any computer with a login you can use",
    detail: "You can already log in there, with a password or another key.",
  },
  {
    id: "ugos",
    title: "Ugreen NAS (UGOS)",
    detail: "Its Personal Folder is the home folder of your login.",
  },
  {
    id: "proxmox",
    title: "Proxmox host or VM",
    detail: "The login's authorized_keys file may be a link to a shared file.",
  },
];

// The public key as one line. Shown in full, because the owner copies it.
export function PublicKeyBlock({ publicKey }: { publicKey: string }) {
  return (
    <div className="key-panel">
      <p className="label">Public key · not secret</p>
      <pre className="key-block" tabIndex={0} aria-label="Public key">
        {publicKey}
      </pre>
      <p className="small muted">
        This is the public key. It is not secret. The private key never leaves
        your vault.
      </p>
      <CopyButton label="public key" text={publicKey} />
    </div>
  );
}

function Command({ text, label }: { text: string; label: string }) {
  return (
    <div className="command-block">
      <pre className="key-block" tabIndex={0} aria-label={label}>
        {text}
      </pre>
      <CopyButton label="command" text={text} />
    </div>
  );
}

function CheckFirst({ children }: { children: ReactNode }) {
  return (
    <div className="check-path">
      <p className="label">Check the path first</p>
      <p className="small">{children}</p>
    </div>
  );
}

export function InstallSteps({
  name,
  user,
  publicKey,
}: {
  name: string;
  user: string;
  publicKey: string;
}) {
  const [platform, setPlatform] = useState<Platform>("linux");
  const group = useId();
  const login = user || "your login";
  return (
    <div>
      <h3 id={`${group}-title`}>Install the key on {name}</h3>
      <p>
        Put the public key on the machine, in the file that lets your login in.
        Use access you already have: the machine's admin page, or an account
        that can already log in. homectl cannot install it for you.
      </p>
      <fieldset className="plain-fieldset">
        <legend className="sub-title">Where is this machine?</legend>
        <div className="radio-group">
          {PLATFORMS.map((item) => (
            <RadioRow
              key={item.id}
              name={`${group}-platform`}
              value={item.id}
              checked={platform === item.id}
              onChange={() => setPlatform(item.id)}
              title={item.title}
              detail={item.detail}
            />
          ))}
        </div>
      </fieldset>

      {platform === "linux" ? (
        <ol className="plain-steps">
          <li>Log in to the machine as {login}, or ask whoever set it up.</li>
          <li>
            Make sure the folder for keys exists and only you can read it:
            <Command
              label="folder command"
              text="mkdir -p ~/.ssh && chmod 700 ~/.ssh"
            />
          </li>
          <li>
            Add the public key as one line in the keys file:
            <Command
              label="key command"
              text={`echo '${publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`}
            />
          </li>
          <li>
            <CheckFirst>
              Run echo $HOME first. The key belongs in the home folder of{" "}
              {login}. If that folder is not the one you expect, stop and check
              before you write anything.
            </CheckFirst>
          </li>
        </ol>
      ) : null}

      {platform === "ugos" ? (
        <ol className="plain-steps">
          <li>
            Open Control Panel, then User, and turn on Personal Folder for{" "}
            {login}.
          </li>
          <li>
            Open that login's Personal Folder in File Station. Make a folder
            named .ssh, and inside it a file named authorized_keys.
          </li>
          <li>
            Put the public key in authorized_keys as one line, and save the
            file.
            <Command label="public key" text={publicKey} />
          </li>
          <li>
            <CheckFirst>
              The Personal Folder must be the home folder of {login}. Do not
              turn off the protection on the home folder to make this work. If
              the folder is missing or you cannot see it, ask the NAS
              administrator.
            </CheckFirst>
          </li>
        </ol>
      ) : null}

      {platform === "proxmox" ? (
        <ol className="plain-steps">
          <li>Open a shell on the machine as {login}, from its console.</li>
          <li>
            Find out where the keys file really is. It may be a link:
            <Command
              label="path command"
              text="readlink -f ~/.ssh/authorized_keys"
            />
          </li>
          <li>
            Add the public key as one line to the file that command printed, not
            to the link.
            <Command label="public key" text={publicKey} />
          </li>
          <li>
            <CheckFirst>
              If readlink prints nothing, the file does not exist yet: create
              ~/.ssh with mode 700 first, then the file with mode 600.
            </CheckFirst>
          </li>
        </ol>
      ) : null}

      <Notice>
        After you install the key, the next step checks the machine's identity.
        Nothing is trusted until you confirm it there.
      </Notice>
    </div>
  );
}
