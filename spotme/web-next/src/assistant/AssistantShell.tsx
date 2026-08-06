/**
 * Assistant shell (Phase 6D) — the conversational map surface, rendering the
 * controller's state through the pure components. Inert: fixtures only, no
 * routing/auth/backend/model. NOT deployed and NOT mounted by App (the 6E
 * fence asserts this).
 */

import type { AssistantController, AssistantUiState } from './controller';
import { AnswerCard, QueryBar, ReviewFacetPanel, RouteCard, SensitiveNotice } from './components';
import './assistant.css';

export function AssistantShell(p: {
  controller: AssistantController;
  state: AssistantUiState;
  rerender(): void;
}) {
  const c = p.controller;
  const s = p.state;

  return (
    <main className="as-shell" aria-label="Map assistant">
      <h1>Ask the map</h1>

      <QueryBar
        value={c.queryText}
        voice={c.voiceState}
        busy={s.kind === 'asking'}
        onChange={(v) => { c.queryText = v; p.rerender(); }}
        onSubmit={() => void c.ask().then(p.rerender)}
      />

      {s.kind === 'asking' && <p role="status" className="as-busy">Looking at the evidence…</p>}

      {s.kind === 'failed' && (
        <p role="alert" className="as-honest">{s.message}</p>
      )}

      {s.kind === 'answered' && (
        <>
          {s.response.sensitiveNotice && <SensitiveNotice notice={s.response.sensitiveNotice} />}
          <AnswerCard answer={s.response.answer} />
        </>
      )}

      {c.review && <ReviewFacetPanel review={c.review} />}
      {c.route && <RouteCard route={c.route} />}
    </main>
  );
}
