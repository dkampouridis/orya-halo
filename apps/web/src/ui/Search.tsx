import type { SearchResult } from "@orya-halo/schema";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { haloActions, useHalo } from "../core/store.ts";
import { accentStyle } from "./accents.ts";
import { useDebounced, usePresence, useServices } from "./hooks.ts";
import { Icon, Ring } from "./icons.tsx";
import { groupResults, moveActive } from "./search-model.ts";

const PLACEHOLDER = "Search flights, ships, satellites, places";
const optionId = (index: number): string => `search-option-${index}`;

/**
 * Search: the only pill. `/` opens it; results are grouped by layer with the
 * layer's lamp; arrow keys and Enter fly there. On phones it is an icon that
 * opens to the full width.
 */
export function Search() {
  const open = useHalo((s) => s.searchOpen);
  const services = useServices();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const term = useDebounced(query.trim(), 160);
  const asking = open && term.length > 0;
  const search = useQuery({
    queryKey: ["search", term],
    queryFn: () => (services ? services.search(term) : Promise.resolve([] as SearchResult[])),
    enabled: asking && services !== null,
    staleTime: 15_000,
    // The last answer stays up while the next one loads, so the list does not blink per keystroke.
    placeholderData: keepPreviousData,
  });
  const model = useMemo(() => groupResults(search.data ?? []), [search.data]);

  // A new answer puts the keyboard back on the best match.
  const [answered, setAnswered] = useState(search.data);
  if (answered !== search.data) {
    setAnswered(search.data);
    setActive(0);
  }

  useEffect(() => {
    if (open) {
      input.current?.focus({ preventScroll: true });
    } else {
      setQuery("");
      if (document.activeElement === input.current) input.current?.blur();
    }
  }, [open]);

  const panel = usePresence(asking, 150);
  const count = model.flat.length;
  const actions = haloActions();

  const choose = (result: SearchResult): void => {
    // openResult closes the search; the effect above clears the field.
    actions.openResult(result);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      actions.setSearchOpen(false);
      return;
    }
    if (event.key === "Enter") {
      const result = model.flat[active];
      if (result) {
        event.preventDefault();
        choose(result);
      }
      return;
    }
    // Home and End belong to the caret while there is text to move through.
    if ((event.key === "Home" || event.key === "End") && !event.ctrlKey) return;
    const next = moveActive(active, event.key, count);
    if (next !== null) {
      event.preventDefault();
      setActive(next);
    }
  };

  let body: React.ReactNode;
  if (!services) {
    body = (
      <p className="results-note" role="status">
        <Ring /> Search is getting ready.
      </p>
    );
  } else if (search.isError) {
    body = (
      <p className="results-note" role="status">
        Search isn't answering right now. Try again in a moment.
      </p>
    );
  } else if (search.data === undefined) {
    body = (
      <p className="results-note" role="status">
        <Ring /> Searching
      </p>
    );
  } else if (count === 0) {
    body = (
      <p className="results-note" role="status">
        No match. Try a flight number, a ship name, a satellite or a city.
      </p>
    );
  } else {
    body = (
      <>
        {model.groups.map((group) => (
          <div key={group.id} role="group" aria-labelledby={`search-group-${group.id}`}>
            <p
              className="group-name"
              id={`search-group-${group.id}`}
              style={group.layer ? accentStyle(group.layer) : undefined}
            >
              <i className="lamp lamp-small" data-lamp={group.layer ? "lit" : "hollow"} />
              {group.label}
            </p>
            {group.items.map(({ result, index }) => (
              <div
                key={`${result.type}-${result.ref ? `${result.ref.kind}.${result.ref.id}` : `${result.lon},${result.lat}`}-${result.title}`}
                id={optionId(index)}
                className="result"
                role="option"
                aria-selected={index === active}
                onPointerMove={() => {
                  if (index !== active) setActive(index);
                }}
                onClick={() => choose(result)}
              >
                <span className="result-name">{result.title}</span>
                {result.subtitle ? <span className="result-sub">{result.subtitle}</span> : null}
              </div>
            ))}
          </div>
        ))}
        <p className="results-hint" aria-hidden="true">
          <span>
            <kbd className="key">↑</kbd>
            <kbd className="key">↓</kbd> to move
          </span>
          <span>
            <kbd className="key">Enter</kbd> to fly there
          </span>
          <span>
            <kbd className="key">Esc</kbd> to close
          </span>
        </p>
      </>
    );
  }

  return (
    <div
      className="search enter"
      role="search"
      ref={wrap}
      onBlur={(event) => {
        // Focus leaving the field and its results closes the search; moving within does not.
        if (open && !wrap.current?.contains(event.relatedTarget)) actions.setSearchOpen(false);
      }}
    >
      <button
        type="button"
        className="search-open glass"
        aria-label="Search"
        onClick={() => actions.setSearchOpen(true)}
      >
        <Icon name="search" />
      </button>
      <label className="search-field glass">
        <Icon name="search" className="search-icon" />
        <input
          ref={input}
          type="text"
          value={query}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder={PLACEHOLDER}
          aria-label={PLACEHOLDER}
          role="combobox"
          aria-expanded={panel.mounted && !panel.closing}
          // Only while the list exists: a reference to nothing is an error to assistive tech.
          aria-controls={panel.mounted ? "search-results" : undefined}
          aria-autocomplete="list"
          aria-activedescendant={asking && count > 0 ? optionId(active) : undefined}
          onChange={(event) => setQuery(event.target.value)}
          onFocus={() => {
            if (!open) actions.setSearchOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd className="key search-key" aria-hidden="true">
          /
        </kbd>
      </label>
      {panel.mounted ? (
        <div
          id="search-results"
          className="results glass"
          role="listbox"
          aria-label="Search results"
          data-closing={panel.closing ? "" : undefined}
          // Keep focus in the field while a result is pressed, so the press is not a blur.
          onPointerDown={(event) => event.preventDefault()}
        >
          {body}
        </div>
      ) : null}
    </div>
  );
}
