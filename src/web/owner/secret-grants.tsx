import { type FormEvent, useEffect, useState } from "react";
import { describeError, ownerCall, type SecretDestination } from "./api";
import { DestinationBlock } from "./secret";
import { Notice, PasswordStep } from "./ui";

interface SavedGrant {
  id: string;
  name: string;
  client: string;
  task?: string;
  fields: string[];
  destination: SecretDestination;
}

export function SavedSecretGrants({
  onError,
}: {
  onError: (error: unknown) => unknown;
}) {
  const [grants, setGrants] = useState<SavedGrant[]>([]);
  const [selected, setSelected] = useState<string>();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [revoked, setRevoked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void ownerCall<SavedGrant[]>("/v1/owner/secrets/saved-grants")
      .then((items) => {
        if (!cancelled) setGrants(items);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        onError(failure);
        setError(describeError(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [onError]);

  async function revoke(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault();
    if (busy || !password) return;
    const typed = password;
    setPassword("");
    setBusy(true);
    setError(undefined);
    try {
      await ownerCall("/v1/owner/secrets/revoke-grant", {
        id,
        password: typed,
      });
      setGrants((current) => current.filter((grant) => grant.id !== id));
      setSelected(undefined);
      setRevoked(true);
    } catch (failure) {
      onError(failure);
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  if (grants.length === 0 && !error && !revoked) return null;
  return (
    <section className="stack" aria-labelledby="saved-secret-grants-heading">
      <h3 id="saved-secret-grants-heading">Saved secret reuse</h3>
      {grants.map((grant) => (
        <article className="stack" key={grant.id}>
          <h4>{grant.name}</h4>
          <p className="small">
            Assistant <span className="mono">{grant.client}</span>
            {grant.task ? (
              <>
                {" "}
                / Task <span className="mono">{grant.task}</span>
              </>
            ) : null}
          </p>
          <p className="small">Fields {grant.fields.join(", ")}</p>
          <DestinationBlock destination={grant.destination} />
          {selected === grant.id ? (
            <form
              className="stack"
              method="post"
              onSubmit={(event) => void revoke(event, grant.id)}
            >
              <PasswordStep
                value={password}
                onChange={setPassword}
                hint="confirm revoking this grant"
              />
              <div className="row">
                <button
                  type="submit"
                  className="danger"
                  disabled={busy || !password}
                >
                  Confirm revoke
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPassword("");
                    setSelected(undefined);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPassword("");
                setSelected(grant.id);
                setRevoked(false);
                setError(undefined);
              }}
            >
              Revoke reuse
            </button>
          )}
        </article>
      ))}
      {revoked ? (
        <Notice tone="good">
          Reuse revoked. The secret stays in the vault.
        </Notice>
      ) : null}
      {error ? <Notice tone="bad">{error}</Notice> : null}
    </section>
  );
}
