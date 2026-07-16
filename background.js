/**
 * Beautify extension - background service worker
 * Calls Poolside's "Laguna M.1 (free)" model via OpenRouter (using the
 * user's own OpenRouter API key, stored locally) to generate a CSS-only
 * redesign for the current page's DOM structure + existing CSS. Runs in
 * the background so the request isn't subject to the target page's
 * CSP/CORS restrictions.
 */

// OpenRouter model slug for Poolside's free coding-agent model. Swap for
// another OpenRouter model id (e.g. 'poolside/laguna-m.1' the paid tier,
// or any other OpenRouter-hosted model) if you want something else.
const MODEL = 'poolside/laguna-m.1:free';
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';

// The free tier is currently capped at an 8K-token output window (the
// paid tier supports up to 32K) - see openrouter.ai/poolside/laguna-m.1:free.
const MAX_OUTPUT_TOKENS = 8000;

const SYSTEM_PROMPT = `You are an elite product designer and senior front-end
engineer. Agencies hire you specifically to take outdated, cluttered
websites and turn them into something that looks like a completely
different, modern product - using ONLY a CSS stylesheet, with zero HTML
changes. You will be given:
1. Every distinct selector on the page, written as "tag#id.class1.class2"
2. An excerpt of the page's existing CSS (for context on current tokens only)
3. Baseline computed styles and element counts

Your job is to deliver a REAL redesign: a new layout, a new visual language,
a new sense of hierarchy and rhythm - not just recolored buttons and a nicer
font on top of the same cramped structure. A reskin is a failure here.

============================================================
HARD SAFETY RULES (never break these - functionality must survive intact)
============================================================
- Output ONLY raw CSS. No markdown fences, no prose, no comments explaining
  yourself.
- Use ONLY the exact tag/id/class selectors you were given. Never invent a
  selector, never guess at one that wasn't listed.
- Never set "display: none" or "visibility: hidden" on anything in the
  provided selector list - every existing piece of content and every
  interactive control must stay visible, reachable, and clickable.
- Do not change the tabular behavior of <table>/<thead>/<tbody>/<tr>/<th>/
  <td> (keep them tabular - grid/flex on table elements breaks table
  semantics badly). You may still fully restyle their appearance
  (colors, spacing, borders, sticky header, alternating rows, etc).
- Do not change the fundamental type/semantics of form controls (an
  <input> must stay operable as its type; a <select> must stay a native
  select, etc). You may freely restyle their appearance and arrange them
  in new grid/flex layouts via their surrounding label/container elements.
- Assume this stylesheet is injected AFTER the page's own CSS - use
  !important where needed to reliably beat old inline styles or legacy
  rules, especially on color, font, spacing, border and background
  properties.

============================================================
YOU ARE ENCOURAGED (this is how you deliver a NEW layout, not a reskin)
============================================================
- You MAY confidently set/change "display", "position", "flex-direction",
  "grid-template-columns", "grid-template-areas", "gap", "align-items",
  "justify-content", z-index and stacking order on generic structural
  containers: <header>, <nav>, <footer>, <aside>, <main>, <section>, and
  any <div>/<ul>/<ol> whose id/class name suggests it's a layout wrapper
  (e.g. contains words like container, wrapper, row, col, grid, layout,
  sidebar, content, menu, list, panel, card, section, block, group, area).
  Reflowing these is expected and safe - it does not touch table/form
  semantics or remove anything from the DOM.
- Turn a stacked/cramped nav menu into a clean horizontal flex nav bar (or
  a collapsible sidebar on mobile) using the real nav/ul/li selectors given.
- Turn repeated sibling div/li "item" style blocks into a responsive CSS
  Grid of cards (auto-fill/minmax) wherever the selector list suggests many
  similar repeated blocks - this is one of the highest-impact layout
  changes you can make.
- Give the header real visual hierarchy: comfortable height, clear
  logo/title emphasis, a subtle shadow or border, and consider
  "position: sticky; top: 0;" if it suits the page.
- Rebuild forms into a clean single- or two-column grid with clear
  label-to-field grouping and generous spacing, not just isolated
  per-input styling.
- Add at least one real mobile breakpoint (e.g. "@media (max-width: 720px)")
  that meaningfully RE-STACKS the layout (grid columns collapse, sidebar
  becomes a top bar or drawer, nav becomes vertical) - not just smaller text.

============================================================
DESIGN SYSTEM (be decisive and specific to THIS page, not generic)
============================================================
- Pick ONE clear design direction based on what this page actually is
  (e.g. "official portal - calm, trustworthy, high-contrast", "content
  directory - card grid, editorial", "dashboard - dense but organized").
  Do not default to the same generic light-SaaS look for every page.
- Define a small set of CSS custom properties on :root/html for color
  (1 primary, 1-2 neutrals, 1 accent - avoid pure black/white only),
  an 8px-based spacing scale, and a modular type scale, then use those
  variables consistently throughout the stylesheet.
- Use soft shadows, restrained border-radius, and generous whitespace
  instead of hard borders and cramped padding.
- Add subtle transitions (150-250ms ease) on hover/focus states for links,
  buttons, and form fields, and a consistent accent color for anything
  interactive.
- Organize the stylesheet in clear sections in this order: custom
  properties -> base/reset -> typography -> forms & buttons -> tables ->
  navigation/header/footer -> layout/grid rules for containers ->
  responsive breakpoints.`;

function buildUserPrompt(profile) {
  return `Page: ${profile.title} (${profile.url})
Baseline computed styles: background=${profile.baseline.background}, color=${profile.baseline.color}, font=${profile.baseline.font}
Element counts: ${JSON.stringify(profile.counts)}

Distinct element selectors on this page (tag#id.classes), one per line:
${profile.selectors.join('\n')}

Existing CSS excerpt (for reference only - understand current tokens/colors, do not copy verbatim):
${profile.cssExcerpt}

Now design and write the full stylesheet: a real new layout and visual
language for this page, not a reskin of the existing structure.`;
}

async function getApiKey() {
  return new Promise((resolve) => {
    // Now an OpenRouter API key (create one at openrouter.ai/keys),
    // not a Gemini key. Still stored under the same local key so
    // existing installs don't lose their options-page wiring; just
    // make sure the options UI copy/label is updated to say
    // "OpenRouter API key".
    chrome.storage.local.get(['bf_api_key'], (data) => resolve(data.bf_api_key || ''));
  });
}

async function generateDesign(profile) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    return { error: 'no_api_key' };
  }

  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(profile) },
    ],
    max_tokens: MAX_OUTPUT_TOKENS,
    temperature: 0.8,
    // Laguna M.1 supports reasoning, but this is a well-specified
    // CSS-writing task rather than one that benefits from heavy
    // reasoning, so ask OpenRouter for the lowest effort level.
    reasoning: { effort: 'low' },
  };

  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        // Optional but recommended by OpenRouter for analytics/rankings;
        // harmless to omit if you'd rather not send them.
        'HTTP-Referer': 'https://github.com/beautify-extension',
        'X-Title': 'Beautify',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { error: 'network_error', detail: String(e) };
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return { error: 'bad_response' };
  }

  if (!res.ok) {
    const detail = (data && data.error && data.error.message) || JSON.stringify(data).slice(0, 300);
    return { error: `api_error_${res.status}`, detail };
  }

  const choice = data.choices && data.choices[0];
  if (!choice) {
    const errMsg = data.error && data.error.message;
    return { error: errMsg ? 'blocked_' + errMsg : 'empty_response' };
  }

  let css = ((choice.message && choice.message.content) || '').trim();

  // strip stray markdown fences just in case
  css = css.replace(/^```(css)?/i, '').replace(/```$/i, '').trim();

  if (!css) {
    return { error: 'empty_response' };
  }

  if (choice.finish_reason === 'length') {
    // The model ran out of its output budget before finishing the
    // stylesheet. Still return the partial CSS - browsers safely ignore
    // a trailing malformed rule - but flag it so the UI can prompt to
    // regenerate.
    return { css, truncated: true };
  }

  return { css };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GENERATE_AI_DESIGN') {
    generateDesign(msg.profile).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
});
