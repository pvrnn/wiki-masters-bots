// Local review UI for wiki-masters-bots' collection-cleanup skill.
//
// Talks only to the local server (served by scripts/serve-review.mjs), never
// directly to wiki-masters.com -- the server holds the authenticated session
// and relays the real bulk-discard call, so this page never needs (and never
// sees) the site's cookies.

const RARITY_LABEL = { L: 'Légendaire', UR: 'Ultra Rare', SR: 'Super Rare', R: 'Rare', PC: 'Peu Commune', C: 'Commune' };
const ORIGIN_BADGE = { france: '🇫🇷', etranger: '🌍' }; // no badge for 'inconnu' -- nothing to signal

const state = {
  data: null,
  // row_id -> card object, for every card currently rendered (post-discard removals prune this).
  //
  // Keyed by row_id, NOT card_id: a live test proved bulk-discard wants the
  // collection row's own id. Sending card_id gave discarded_count: 0 and
  // "card_not_owned" for every single card, despite a 200 response -- see
  // SKILL.md's "id field" section for the evidence.
  byId: new Map(),
  selected: new Set(),
  query: '',
  originFilter: 'tous',
  countryFilter: 'tous',
  sort: 'q_score',
};

const $main = document.getElementById('main');
const $search = document.getElementById('search');
const $originFilter = document.getElementById('origin-filter');
const $countryFilter = document.getElementById('country-filter');
const $sortOrder = document.getElementById('sort-order');
const $threshold = document.getElementById('threshold');
const $btnSelectBelow = document.getElementById('btn-select-below');
const $statTotal = document.getElementById('stat-total');
const $selBar = document.getElementById('selection-bar');
const $selCount = document.getElementById('selection-count');
const $btnDiscard = document.getElementById('btn-discard');
const $btnClear = document.getElementById('btn-clear');
const $btnReload = document.getElementById('btn-reload');

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

async function loadCollection() {
  $main.innerHTML = '<p class="empty-note">Chargement…</p>';
  const res = await fetch('/api/collection');
  if (!res.ok) {
    $main.innerHTML = `<p class="empty-note">Erreur de chargement (${res.status}). Vérifiez que data/collection-grouped.json existe.</p>`;
    return;
  }
  state.data = await res.json();
  state.byId.clear();
  for (const g of state.data.groups) {
    for (const t of g.themes) {
      for (const c of t.cards) state.byId.set(c.row_id, c);
    }
  }
  populateCountryFilter();
  render();
}

/** Only countries actually present, most common first -- 200 empty options would bury them. */
function populateCountryFilter() {
  const counts = new Map();
  for (const c of state.byId.values()) {
    if (c.country) counts.set(c.country, { label: c.country_label ?? c.country, n: (counts.get(c.country)?.n ?? 0) + 1 });
  }
  const previous = $countryFilter.value;
  $countryFilter.innerHTML = '<option value="tous">Tous pays</option><option value="__none">Pays inconnu</option>';
  for (const [code, { label, n }] of [...counts.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${label} (${n})`;
    $countryFilter.appendChild(opt);
  }
  $countryFilter.value = [...$countryFilter.options].some((o) => o.value === previous) ? previous : 'tous';
}

function sortedCards(cards) {
  if (state.sort === 'q_score') return cards; // build-grouped.mjs's own order
  const dir = state.sort === 'keep_asc' ? 1 : -1;
  return [...cards].sort((a, b) => dir * ((a.keep_score ?? 50) - (b.keep_score ?? 50)));
}

function cardMatchesFilters(card) {
  if (state.originFilter !== 'tous' && card.origin !== state.originFilter) return false;
  if (state.countryFilter === '__none' && card.country) return false;
  if (state.countryFilter !== 'tous' && state.countryFilter !== '__none' && card.country !== state.countryFilter) return false;
  if (!state.query) return true;
  const hay = normalize(`${card.title} ${card.category ?? ''}`);
  return hay.includes(state.query);
}

function render() {
  const total = state.data.groups.reduce((s, g) => s + g.count, 0);
  $statTotal.textContent = `${total} cartes`;

  $main.innerHTML = '';
  if (total === 0) {
    $main.innerHTML = '<p class="empty-note">Collection vide (ou tout a déjà été défaussé). Relancez fetch-collection.mjs pour resynchroniser.</p>';
    return;
  }

  for (const group of state.data.groups) {
    if (group.count === 0) continue;
    const rarityEl = document.createElement('section');
    rarityEl.className = 'rarity-group';
    rarityEl.dataset.rarity = group.rarity;

    const header = document.createElement('div');
    header.className = 'rarity-header';
    header.innerHTML = `
      <span class="rarity-badge" style="background:var(--r-${group.rarity}, var(--r-C))">${group.rarity}</span>
      <strong>${RARITY_LABEL[group.rarity] ?? group.rarity}</strong>
      <span class="rarity-count">${group.count} cartes</span>
      <span class="chevron">▾</span>
    `;
    header.addEventListener('click', () => rarityEl.classList.toggle('collapsed'));
    rarityEl.appendChild(header);

    const themeList = document.createElement('div');
    themeList.className = 'theme-list';

    for (const theme of group.themes) {
      if (theme.count === 0) continue;
      const themeEl = document.createElement('div');
      themeEl.className = 'theme-block';
      themeEl.dataset.themeKey = theme.key;

      const themeHeader = document.createElement('div');
      themeHeader.className = 'theme-header';
      themeHeader.innerHTML = `
        <span class="label">${theme.label}</span>
        <span class="count">${theme.count}</span>
        <button class="select-all" type="button">tout (dé)sélectionner</button>
        <span class="chevron">▾</span>
      `;
      themeHeader.querySelector('.select-all').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleThemeSelection(theme);
      });
      themeHeader.addEventListener('click', (e) => {
        if (e.target.closest('.select-all')) return;
        themeEl.classList.toggle('collapsed');
      });
      themeEl.appendChild(themeHeader);

      const grid = document.createElement('div');
      grid.className = 'card-grid';
      for (const card of sortedCards(theme.cards)) {
        grid.appendChild(renderCard(card));
      }
      themeEl.appendChild(grid);
      themeList.appendChild(themeEl);
    }

    rarityEl.appendChild(themeList);
    $main.appendChild(rarityEl);
  }

  applyFilter();
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.rowId = card.row_id;
  if (state.selected.has(card.row_id)) el.classList.add('selected');

  const img = card.image_url
    ? `<img src="${card.image_url}" loading="lazy" alt="" />`
    : `<span class="noimg">pas d'image</span>`;

  // A bare emoji floating over the thumbnail was easy to miss and, worse,
  // easy to confuse with the photo itself when the card's own image is a
  // flag (municipality/country flags are common in Géographie). Origin is
  // now a labelled chip in the info panel instead -- part of the data
  // reading, not overlaid on the picture.
  const originTag =
    card.origin === 'france'
      ? '<span class="origin-tag france">🇫🇷 France</span>'
      : card.origin === 'etranger'
        ? '<span class="origin-tag etranger">🌍 Étranger</span>'
        : '';
  // With a known country, name it instead of the generic "Étranger".
  const countryTag =
    card.country && card.origin !== 'france'
      ? `<span class="origin-tag etranger" title="${escapeAttr(countryTitle(card))}">🌍 ${escapeHtml(card.country_label ?? card.country)}</span>`
      : '';

  el.innerHTML = `
    <div class="check">✓</div>
    ${card.starred ? '<div class="starred">★</div>' : ''}
    ${keepBadge(card)}
    <div class="thumb">${img}</div>
    <div class="info">
      <p class="title" title="${escapeAttr(card.title)}">${escapeHtml(card.title)}</p>
      <div class="meta">
        <span>ATK ${card.atk ?? '?'}</span>
        <span>DEF ${card.def ?? '?'}</span>
      </div>
      ${countryTag || originTag}
    </div>
  `;
  el.addEventListener('click', () => toggleCard(card.row_id, el));
  return el;
}

function keepBadge(card) {
  if (typeof card.keep_score !== 'number') return '';
  const level = card.keep_score < 30 ? 'low' : card.keep_score < 60 ? 'mid' : 'high';
  const b = card.keep_breakdown ?? {};
  const part = (label, v) => `${label} ${v ?? '—'}`;
  const title = [
    `Score de conservation : ${card.keep_score}/100`,
    part('stats', b.stats),
    part('intérêt IA', b.ai),
    part('préférences', b.prefs),
    b.duplicate ? 'doublon : une autre copie est mieux notée' : null,
    card.starred ? 'favorite : toujours 100' : null,
  ]
    .filter(Boolean)
    .join('\n');
  return `<div class="keep-badge ${level}${b.duplicate ? ' dup' : ''}" title="${escapeAttr(title)}">${card.keep_score}</div>`;
}

function countryTitle(card) {
  return typeof card.country_conf === 'number' && card.country_conf < 1
    ? `Pays estimé par l'IA (confiance ${Math.round(card.country_conf * 100)} %)`
    : 'Pays lu dans la catégorie';
}

function escapeHtml(s) {
  return (s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

function toggleCard(cardId, el) {
  if (state.selected.has(cardId)) {
    state.selected.delete(cardId);
    el.classList.remove('selected');
  } else {
    state.selected.add(cardId);
    el.classList.add('selected');
  }
  updateSelectionBar();
}

/**
 * Only affects cards passing the current search/origin filters, not every
 * card in the theme -- otherwise filtering to "Étranger" and clicking
 * "select all" would silently also select the French cards hidden by that
 * same filter, which defeats the point of having the filter at all.
 */
function toggleThemeSelection(theme) {
  const ids = theme.cards.filter(cardMatchesFilters).map((c) => c.row_id);
  if (ids.length === 0) return;
  const allSelected = ids.every((id) => state.selected.has(id));
  for (const id of ids) {
    if (allSelected) state.selected.delete(id);
    else state.selected.add(id);
  }
  render();
}

/**
 * Selects (never discards) every card passing the current filters whose keep
 * score is under the threshold. Starred cards score 100, so they can't be
 * caught by this. Discarding still goes through the button and its modal.
 */
function selectBelowThreshold() {
  const limit = Number($threshold.value);
  if (!Number.isFinite(limit)) return;
  let added = 0;
  for (const card of state.byId.values()) {
    if (typeof card.keep_score !== 'number' || card.keep_score >= limit || !cardMatchesFilters(card)) continue;
    if (!state.selected.has(card.row_id)) added += 1;
    state.selected.add(card.row_id);
  }
  render();
  updateSelectionBar();
  showToast(`${added} carte(s) ajoutée(s) à la sélection (score < ${limit}).`, 'ok');
}

function updateSelectionBar() {
  const n = state.selected.size;
  $selBar.style.display = n > 0 ? 'flex' : 'none';
  $selCount.textContent = `${n} sélectionnée(s)`;
  $btnDiscard.disabled = n === 0;
}

function applyFilter() {
  state.query = normalize($search.value.trim());
  state.originFilter = $originFilter.value;
  state.countryFilter = $countryFilter.value;
  for (const el of document.querySelectorAll('.card')) {
    const card = state.byId.get(el.dataset.rowId);
    el.classList.toggle('hidden', card ? !cardMatchesFilters(card) : true);
  }
  // Hide theme blocks / rarity groups that end up empty after filtering, so a
  // search doesn't leave a wall of collapsed-looking empty sections.
  for (const themeEl of document.querySelectorAll('.theme-block')) {
    const visible = [...themeEl.querySelectorAll('.card')].some((c) => !c.classList.contains('hidden'));
    themeEl.style.display = visible ? '' : 'none';
  }
  for (const rarityEl of document.querySelectorAll('.rarity-group')) {
    const visible = [...rarityEl.querySelectorAll('.card')].some((c) => !c.classList.contains('hidden'));
    rarityEl.style.display = visible ? '' : 'none';
  }
}

$search.addEventListener('input', applyFilter);
$originFilter.addEventListener('change', applyFilter);
$countryFilter.addEventListener('change', applyFilter);
$sortOrder.addEventListener('change', () => {
  state.sort = $sortOrder.value;
  render();
});
$btnSelectBelow.addEventListener('click', selectBelowThreshold);
$btnReload.addEventListener('click', loadCollection);
$btnClear.addEventListener('click', () => {
  state.selected.clear();
  document.querySelectorAll('.card.selected').forEach((el) => el.classList.remove('selected'));
  updateSelectionBar();
});

// --- Discard flow ------------------------------------------------------

function showToast(message, kind) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function openConfirmModal() {
  const ids = [...state.selected];
  const cards = ids.map((id) => state.byId.get(id)).filter(Boolean);
  const hasConfirmedBefore = localStorage.getItem('wm-discard-confirmed-once') === '1';

  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  const sample = cards.slice(0, 8).map((c) => `• ${escapeHtml(c.title)} (${c.rarity})`).join('<br>');
  const more = cards.length > 8 ? `<br>…et ${cards.length - 8} de plus` : '';

  backdrop.innerHTML = `
    <div class="modal">
      <h2>Défausser ${cards.length} carte${cards.length > 1 ? 's' : ''} ?</h2>
      <p class="warn">Cette action est IRRÉVERSIBLE. Ces cartes seront définitivement retirées de votre collection.</p>
      ${!hasConfirmedBefore ? '<p><strong>Première utilisation :</strong> il est recommandé de tester avec UNE seule carte de faible valeur avant une défausse en masse, pour confirmer que tout fonctionne comme attendu.</p>' : ''}
      <p>${sample}${more}</p>
      <div class="actions">
        <button id="btn-cancel">Annuler</button>
        <button class="danger" id="btn-confirm">Défausser définitivement</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const $confirm = backdrop.querySelector('#btn-confirm');
  backdrop.querySelector('#btn-cancel').addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

  $confirm.addEventListener('click', async () => {
    $confirm.disabled = true;
    $confirm.textContent = 'Envoi…';
    try {
      const res = await fetch('/api/discard', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ row_ids: ids }),
      });
      const result = await res.json();

      if (!res.ok || !result.ok) {
        backdrop.remove();
        showToast(`Échec (${res.status}): ${result.error ?? JSON.stringify(result)}`, 'error');
        return;
      }

      // A 200 from the site does not mean every card was actually discarded
      // -- it can return discarded_count: 0 with every id individually
      // marked "card_not_owned". Only remove what the site confirms.
      const succeeded = result.succeededIds ?? [];
      const failed = result.failed ?? [];

      for (const id of succeeded) {
        state.selected.delete(id);
        state.byId.delete(id);
      }
      removeCardsFromData(succeeded);
      backdrop.remove();
      render();

      if (succeeded.length > 0) {
        localStorage.setItem('wm-discard-confirmed-once', '1');
        showToast(`${succeeded.length} carte(s) défaussée(s).`, 'ok');
      }
      if (failed.length > 0) {
        const reasons = [...new Set(failed.map((f) => f.error))].join(', ');
        showToast(`${failed.length} carte(s) refusée(s) par le site (${reasons}). Toujours sélectionnée(s).`, 'error');
        // Leave the failed ones selected so the user can retry or inspect
        // them, rather than silently losing the selection.
      }
    } catch (err) {
      backdrop.remove();
      showToast(`Erreur réseau: ${err.message}`, 'error');
    }
  });
}

function removeCardsFromData(ids) {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  for (const g of state.data.groups) {
    for (const t of g.themes) {
      const before = t.cards.length;
      t.cards = t.cards.filter((c) => !idSet.has(c.row_id));
      t.count = t.cards.length;
      g.count -= before - t.cards.length;
    }
  }
}

$btnDiscard.addEventListener('click', () => {
  if (state.selected.size === 0) return;
  openConfirmModal();
});

loadCollection();
