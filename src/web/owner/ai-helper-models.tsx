// The model picker in the AI helper sheet: a list the broker fetched from the
// provider, with a filter, an All/Free toggle when prices are known, badges, and
// a way to type a model ID the list does not show.
import { useId, useState } from "react";
import type { ModelCard, ModelList } from "./ai-helper-api";
import { MODEL_HELP } from "./ai-helper-copy";
import { Field, Notice } from "./ui";

export function priceLine(card: ModelCard): string | undefined {
  if (card.free) return "Free";
  const price = card.price;
  if (price === undefined) return undefined;
  return `$${price.promptPerMillion.toFixed(2)} in · $${price.completionPerMillion.toFixed(2)} out per 1M tokens`;
}

function contextLabel(tokens: number | undefined): string | undefined {
  if (tokens === undefined) return undefined;
  return tokens >= 1000
    ? `${Math.round(tokens / 1000)}K context`
    : `${tokens} tokens`;
}

function matches(card: ModelCard, filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  return (
    needle.length === 0 ||
    card.id.toLowerCase().includes(needle) ||
    card.name.toLowerCase().includes(needle)
  );
}

export function ModelPicker({
  list,
  loading,
  error,
  selected,
  onSelect,
  onRefresh,
}: {
  list: ModelList | undefined;
  loading: boolean;
  error: string | undefined;
  selected: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  const baseId = useId();
  const [filter, setFilter] = useState("");
  const [freeOnly, setFreeOnly] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [customDraft, setCustomDraft] = useState("");

  const shown = (list?.models ?? []).filter(
    (card) => matches(card, filter) && (!freeOnly || card.free),
  );

  return (
    <div className="stack">
      <div className="row">
        <button type="button" onClick={onRefresh} disabled={loading}>
          {loading ? "Loading models…" : "Refresh list"}
        </button>
      </div>
      {error ? <Notice tone="bad">{error}</Notice> : null}
      {list === undefined && !loading && !error ? (
        <p className="small muted">{MODEL_HELP}</p>
      ) : null}
      {list !== undefined ? (
        <>
          <Field id={`${baseId}-filter`} label="Filter models">
            <input
              id={`${baseId}-filter`}
              type="search"
              autoComplete="off"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </Field>
          {list.pricing ? (
            <div className="segmented" role="group" aria-label="Which models">
              <button
                type="button"
                aria-pressed={!freeOnly}
                onClick={() => setFreeOnly(false)}
              >
                All
              </button>
              <button
                type="button"
                aria-pressed={freeOnly}
                onClick={() => setFreeOnly(true)}
              >
                Free
              </button>
            </div>
          ) : null}
          {list.truncated ? (
            <p className="small muted">
              Showing the first models the provider sent. Use Custom model ID
              for one that is not listed.
            </p>
          ) : null}
          {shown.length === 0 ? (
            <p className="small muted">
              {list.models.length === 0
                ? "The provider did not list any models. Use Custom model ID to type one."
                : "No models match. Clear the filter or choose All."}
            </p>
          ) : (
            <ul className="model-list" aria-label="Models">
              {shown.map((card) => (
                <ModelRow
                  key={card.id}
                  card={card}
                  groupName={`${baseId}-model`}
                  selected={selected === card.id}
                  onSelect={() => onSelect(card.id)}
                />
              ))}
            </ul>
          )}
        </>
      ) : null}
      <div>
        <button
          type="button"
          className="quiet"
          aria-expanded={customOpen}
          onClick={() => setCustomOpen(!customOpen)}
        >
          Custom model ID…
        </button>
      </div>
      {customOpen ? (
        <Field
          id={`${baseId}-custom`}
          label="Model ID"
          hint="exactly as your provider names it"
        >
          <input
            id={`${baseId}-custom`}
            type="text"
            autoComplete="off"
            value={customDraft}
            onChange={(event) => {
              setCustomDraft(event.target.value);
              onSelect(event.target.value.trim());
            }}
          />
        </Field>
      ) : null}
      <p className="small" aria-live="polite">
        {selected.length > 0 ? (
          <>
            Selected: <span className="mono">{selected}</span>
          </>
        ) : (
          <span className="muted">No model selected yet.</span>
        )}
      </p>
    </div>
  );
}

function ModelRow({
  card,
  groupName,
  selected,
  onSelect,
}: {
  card: ModelCard;
  groupName: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const price = priceLine(card);
  const context = contextLabel(card.contextLength);
  return (
    <li>
      <label className={selected ? "model-card selected" : "model-card"}>
        <input
          type="radio"
          name={groupName}
          value={card.id}
          checked={selected}
          onChange={onSelect}
        />
        <span className="model-text">
          <span className="model-name">{card.name}</span>
          <span className="model-id mono">{card.id}</span>
          <span className="model-badges">
            {card.router ? <span className="badge info">Router</span> : null}
            {card.free ? <span className="badge good">Free</span> : null}
            {context ? <span className="badge">{context}</span> : null}
          </span>
          {price ? <span className="model-price small">{price}</span> : null}
          {card.description ? (
            <span className="model-desc small muted">{card.description}</span>
          ) : null}
        </span>
      </label>
    </li>
  );
}
