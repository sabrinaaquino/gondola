import { useEffect, useRef, useState, type ReactNode } from "react";
import { CloseIcon, SearchIcon } from "./Icons";

interface ConversationHit {
  conversationId: string;
  agentId: string;
  title: string;
  snippet: string;
  updatedAt: string;
  score: number;
}

interface ConversationSearchProps {
  agentNames: Map<string, string>;
  onOpen: (conversationId: string) => void | Promise<void>;
  compact?: boolean;
  // Notifies the parent when a query is active, so it can hide its own list and
  // let the ranked results stand in as the list.
  onActiveChange?: (active: boolean) => void;
}

const CONV_SEARCH_CSS = `
.conv-search { display: grid; gap: 10px; margin-bottom: 14px; }
.conv-search-bar { display: flex; align-items: center; gap: 9px; height: 40px; padding: 0 12px; border: 1px solid rgba(255,255,255,.08); border-radius: 11px; background: rgba(255,255,255,.025); box-shadow: inset 0 1px 0 rgba(255,255,255,.015); transition: border-color .15s, background .15s, box-shadow .15s, border-radius .15s; }
.conv-search-bar:hover { border-color: rgba(255,255,255,.12); background: rgba(255,255,255,.035); }
.conv-search-bar:focus-within { border-color: rgba(255,255,255,.17); background: rgba(255,255,255,.045); box-shadow: 0 0 0 2px rgba(255,255,255,.025); }
.conv-search-icon { flex: 0 0 auto; color: #6f7782; }
.conv-search-bar:focus-within .conv-search-icon { color: #9aa3af; }
.conv-search-bar input { flex: 1; min-width: 0; height: 100%; padding: 0; background: transparent; border: 0; outline: none; color: #e7edf5; font: inherit; font-size: 13px; line-height: 1; }
.conv-search-bar input::placeholder { color: #626b77; opacity: 1; }
.conv-search-spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.15); border-top-color: #9fb4d0; border-radius: 50%; animation: conv-spin .7s linear infinite; }
@keyframes conv-spin { to { transform: rotate(360deg); } }
.conv-search-clear { flex: 0 0 auto; width: 24px; height: 24px; display: grid; place-items: center; margin-right: -5px; padding: 0; border: 0; border-radius: 6px; color: #767f8b; background: transparent; cursor: pointer; }
.conv-search-clear:hover { color: #d9dee5; background: rgba(255,255,255,.06); }

/* The result set is a labelled dropdown, not another list section. */
.conv-search-panel { display: grid; gap: 5px; }
.conv-search-mode { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 1px 3px 7px; border-bottom: 1px solid rgba(255,255,255,.06); }
.conv-search-count { color: #808b99; font-size: 9px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
.conv-search-badge { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(133,169,224,.3); background: rgba(133,169,224,.12); color: #accbe8; font-size: 8.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.conv-search-badge::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: #7fa6e0; }
.conv-search-badge.is-keyword { border-color: rgba(200,180,138,.3); background: rgba(200,180,138,.12); color: #d3bd8e; }
.conv-search-badge.is-keyword::before { background: #c8b48a; }
.conv-search-empty { color: #79828f; font-size: 11px; padding: 8px 4px 6px; text-align: center; }
.conv-search-results { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
.conv-search-hit { width: 100%; display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 11px; padding: 9px 11px; border: 1px solid transparent; border-radius: 10px; background: rgba(255,255,255,.02); cursor: pointer; text-align: left; transition: background .12s, border-color .12s; }
.conv-search-hit:hover { background: rgba(255,255,255,.06); border-color: rgba(255,255,255,.09); }
.conv-search-score { width: 34px; height: 4px; border-radius: 2px; background: rgba(255,255,255,.08); overflow: hidden; }
.conv-search-score > span { display: block; height: 100%; background: linear-gradient(90deg, #6f8fc0, #a9c0dd); }
.conv-search-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.conv-search-copy strong { color: #dfe6ef; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conv-search-copy small { color: #6b7480; font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conv-search-mark { padding: 0 1px; border-radius: 3px; background: rgba(133,169,224,.28); color: #eef4fc; font-weight: 700; }
.conv-search-copy small .conv-search-mark { color: #d3ddea; font-weight: 600; background: rgba(133,169,224,.2); }
.conv-search-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; color: #5f6a77; font-size: 9px; white-space: nowrap; }
.conv-search-meta em { color: #8892a0; font-style: normal; }

/* Compact (sidebar): render as an elevated dropdown attached under the input. */
.conv-search.compact { margin: 3px 0 6px; gap: 0; }
.conv-search.compact .conv-search-bar { height: 32px; padding: 0 9px; border-color: rgba(255,255,255,.065); border-radius: 8px; gap: 8px; background: rgba(255,255,255,.018); }
.conv-search.compact .conv-search-bar:hover { border-color: rgba(255,255,255,.1); background: rgba(255,255,255,.03); }
.conv-search.compact .conv-search-bar:focus-within { border-color: rgba(255,255,255,.15); background: rgba(255,255,255,.04); box-shadow: 0 0 0 2px rgba(255,255,255,.02); }
.conv-search.compact.is-open .conv-search-bar { border-color: rgba(255,255,255,.12); border-bottom-color: transparent; border-radius: 10px 10px 0 0; background: rgba(255,255,255,.045); box-shadow: none; }
.conv-search.compact .conv-search-bar input { font-size: 12px; font-weight: 450; }
.conv-search.compact .conv-search-panel { gap: 3px; margin-top: 0; padding: 5px; border: 1px solid rgba(255,255,255,.12); border-top: 0; border-radius: 0 0 10px 10px; background: #16171a; box-shadow: 0 18px 34px -14px rgba(0,0,0,.7); }
.conv-search.compact .conv-search-mode { padding: 3px 6px 6px; margin: 0 1px 1px; }
.conv-search.compact .conv-search-results { gap: 2px; max-height: 46vh; overflow-y: auto; scrollbar-width: none; }
.conv-search.compact .conv-search-results::-webkit-scrollbar { width: 0; height: 0; }
.conv-search.compact .conv-search-hit { grid-template-columns: minmax(0,1fr) auto; gap: 8px; padding: 7px 8px; border-radius: 7px; background: transparent; }
.conv-search.compact .conv-search-copy strong { font-size: 12px; font-weight: 550; }
.conv-search.compact .conv-search-copy small { font-size: 10px; }
.conv-search.compact .conv-search-meta { font-size: 8.5px; }
.conv-search.compact .conv-search-empty { padding: 8px 4px 6px; font-size: 10.5px; }
`;

function timeAgo(value: string): string {
  const seconds = Math.max(1, Math.floor((Date.now() - Date.parse(value)) / 1_000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Wrap the matched query terms in the title/snippet so it reads unmistakably as
// search results, not a plain conversation list.
function highlight(text: string, query: string): ReactNode {
  const terms = query.toLowerCase().split(/\s+/).map((term) => term.trim()).filter((term) => term.length > 1);
  if (!terms.length || !text) return text;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "ig");
  const marked = new Set(terms);
  return text.split(pattern).map((part, index) => (
    marked.has(part.toLowerCase())
      ? <mark key={index} className="conv-search-mark">{part}</mark>
      : part
  ));
}

// Semantic conversation search bar. Debounces input, calls the vector-backed
// search endpoint, and renders relevance-ranked results by meaning (falling
// back to keyword mode automatically when embeddings are unavailable).
export function ConversationSearch({ agentNames, onOpen, compact = false, onActiveChange }: ConversationSearchProps) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ConversationHit[]>([]);
  const [semantic, setSemantic] = useState(true);
  const [searching, setSearching] = useState(false);
  const [touched, setTouched] = useState(false);
  const requestRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    onActiveChange?.(trimmed.length > 0);
    if (!trimmed) { setHits([]); setSearching(false); return; }
    setSearching(true);
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch("/api/workspace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "search_conversations", query: trimmed, limit: 8 }),
        });
        const result = await response.json() as { hits?: ConversationHit[]; semantic?: boolean };
        if (requestRef.current !== requestId) return; // a newer query superseded this one
        setHits(result.hits ?? []);
        setSemantic(result.semantic !== false);
      } catch {
        if (requestRef.current === requestId) setHits([]);
      } finally {
        if (requestRef.current === requestId) setSearching(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, onActiveChange]);

  return (
    <div className={`conv-search${compact ? " compact" : ""}${query.trim() ? " is-open" : ""}`}>
      <style>{CONV_SEARCH_CSS}</style>
      <div className={`conv-search-bar ${searching ? "is-loading" : ""}`}>
        <SearchIcon className="conv-search-icon" size={compact ? 13 : 15} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => { setQuery(event.target.value); setTouched(true); }}
          placeholder={compact ? "Search chats" : "Search conversations by meaning"}
          aria-label="Search conversations"
          autoComplete="off"
        />
        {searching ? <span className="conv-search-spinner" aria-hidden="true" /> : query && (
          <button className="conv-search-clear" aria-label="Clear search" onClick={() => setQuery("")}><CloseIcon size={12} /></button>
        )}
      </div>

      {query.trim() && (
        <div className="conv-search-panel">
          <div className="conv-search-mode">
            <span className="conv-search-count">
              {searching && !hits.length ? "Searching" : hits.length ? `${hits.length} result${hits.length === 1 ? "" : "s"}` : ""}
            </span>
            <span className={`conv-search-badge${semantic ? "" : " is-keyword"}`}>{semantic ? "Semantic" : "Keyword"}</span>
          </div>
          {!searching && touched && !hits.length && (
            <p className="conv-search-empty">No conversations match “{query.trim()}”.</p>
          )}
          <ul className="conv-search-results">
            {hits.map((hit) => (
              <li key={hit.conversationId}>
                <button className="conv-search-hit" onClick={() => void onOpen(hit.conversationId)}>
                  {!compact && semantic && (
                    <span className="conv-search-score" title={`Relevance ${(hit.score * 100).toFixed(0)}%`}>
                      <span style={{ width: `${Math.max(8, Math.min(100, hit.score * 100))}%` }} />
                    </span>
                  )}
                  <span className="conv-search-copy">
                    <strong>{highlight(hit.title || "Untitled conversation", query)}</strong>
                    {hit.snippet && <small>{highlight(hit.snippet, query)}</small>}
                  </span>
                  <span className="conv-search-meta">
                    {!compact && <em>{agentNames.get(hit.agentId) ?? "Agent"}</em>}
                    <i>{timeAgo(hit.updatedAt)}</i>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
