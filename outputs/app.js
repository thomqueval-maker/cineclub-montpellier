(() => {
  if (location.protocol === 'file:') {
    const message = document.querySelector('#sourceMessage');
    const button = document.querySelector('#refreshButton');
    if (message) message.textContent = 'Pour charger les séances en direct, lance start-cineclub.bat dans le dossier du site. Il ouvrira cette page avec le serveur local.';
    if (button) {
      button.textContent = 'Serveur requis';
      button.disabled = true;
      button.title = 'Lance start-cineclub.bat dans le dossier du site.';
    }
    return;
  }
  const cinemaUrls = {
    odysseum: 'https://www.pathe.fr/cinemas/cinema-pathe-odysseum',
    comedie: 'https://www.pathe.fr/cinemas/cinema-pathe-comedie'
  };
  const cinemas = { odysseum: 'Pathé Odysseum', comedie: 'Pathé Comédie' };
  const $ = selector => document.querySelector(selector);
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const localDate = date => `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  const weekdays = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  const today = new Date(); today.setHours(0,0,0,0);
  const dates = Array.from({length: 7}, (_, i) => { const date = new Date(today); date.setDate(date.getDate()+i); return date; });
  const loadWanted = () => { try { return JSON.parse(localStorage.getItem('cineclub-wishlist') || '[]'); } catch { return []; } };
  const state = { day: 0, cinema: 'all', filter: 'all', query: '', wanted: loadWanted(), sessions: [], enrichment: {}, requested: new Set(), loading: false, error: '' };

  function feeFor(session) {
    const format = normalize(session.format);
    if (format.includes('70')) return '+ 12 €';
    if ((format.includes('imax') || format.includes('4dx')) && format.includes('3d')) return '+ 9 €';
    if (format.includes('imax') || format.includes('4dx')) return '+ 8 €';
    if (format.includes('3d')) return '+ 2 €';
    return 'inclus · 0 €';
  }
  function isPremium(session) { return feeFor(session) !== 'inclus · 0 €'; }
  function isWanted(title) { return state.wanted.some(item => normalize(item) === normalize(title)); }
  function dateLabel(date, options) { return new Intl.DateTimeFormat('fr-FR', options).format(date); }

  function renderDates() {
    $('#dateNav').innerHTML = dates.map((date, index) => {
      const label = index === 0 ? 'Aujourd’hui' : index === 1 ? 'Demain' : weekdays[date.getDay()];
      return `<button class="date-btn ${index === state.day ? 'selected' : ''}" data-day="${index}" role="tab" aria-selected="${index === state.day}" type="button">${label}<span>${dateLabel(date,{day:'numeric',month:'short'}).replace('.','')}</span></button>`;
    }).join('');
    $('#dateNav').querySelectorAll('[data-day]').forEach(button => button.addEventListener('click', () => { state.day = Number(button.dataset.day); render(); }));
    const date = dates[state.day];
    $('#selectedDateLabel').textContent = state.day === 0 ? 'aujourd’hui' : dateLabel(date, {weekday:'long', day:'numeric', month:'long'});
    $('#resultsTitle').textContent = state.day === 0 ? 'À l’affiche aujourd’hui' : `À l’affiche ${state.day === 1 ? 'demain' : dateLabel(date,{weekday:'long'})}`;
  }

  function renderWatchlist() {
    $('#watchCount').textContent = `${state.wanted.length} film${state.wanted.length > 1 ? 's' : ''}`;
    $('#navCount').textContent = state.wanted.length;
    const list = $('#watchList');
    if (!state.wanted.length) {
      list.innerHTML = '<div class="watch-empty">Ta liste est vide pour le moment.<br>Ajoute un film ou touche ☆ sur une affiche.</div>';
      return;
    }
    list.innerHTML = state.wanted.map(title => `<div class="watch-item"><span class="watch-star"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="m12 2.7 2.88 5.84 6.44.94-4.66 4.54 1.1 6.41L12 17.4l-5.76 3.03 1.1-6.41L2.68 9.48l6.44-.94L12 2.7Z"/></svg></span><span class="watch-name" title="${escapeHTML(title)}">${escapeHTML(title)}</span><button class="watch-remove" data-remove="${escapeHTML(title)}" aria-label="Retirer ${escapeHTML(title)} de ma liste" type="button"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div>`).join('');
    list.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => { state.wanted = state.wanted.filter(item => normalize(item) !== normalize(button.dataset.remove)); save(); }));
  }

  function groupsForDate() {
    const selectedDate = localDate(dates[state.day]);
    let sessions = state.sessions.filter(session => session.date === selectedDate && (state.cinema === 'all' || session.cinemaKey === state.cinema));
    if (state.query) sessions = sessions.filter(session => normalize(session.title).includes(normalize(state.query)));
    if (state.filter === 'included') sessions = sessions.filter(session => !isPremium(session));
    if (state.filter === 'premium') sessions = sessions.filter(isPremium);
    if (state.filter === 'favorites') sessions = sessions.filter(session => isWanted(session.title));
    const groups = new Map();
    for (const session of sessions) {
      const key = normalize(session.title);
      if (!groups.has(key)) groups.set(key, { title: session.title, sessions: [], posterUrl: session.posterUrl, duration: session.duration, synopsis: session.synopsis, genres: session.genres || [] });
      const group = groups.get(key);
      group.sessions.push(session);
      if (!group.posterUrl && session.posterUrl) group.posterUrl = session.posterUrl;
      if (!group.synopsis && session.synopsis) group.synopsis = session.synopsis;
      if (!group.duration && session.duration) group.duration = session.duration;
    }
    return [...groups.values()].sort((a,b) => {
      const aWanted = isWanted(a.title), bWanted = isWanted(b.title);
      return Number(bWanted) - Number(aWanted) || a.title.localeCompare(b.title, 'fr');
    });
  }

  function formatDuration(value) {
    if (!value) return '';
    const raw = String(value);
    if (/\d\s*h/i.test(raw)) return raw;
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0) return raw;
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2,'0')}`;
  }

  function ratingMarkup(title) {
    const data = state.enrichment[normalize(title)];
    if (data?.rating != null) {
      const votes = data.votes ? ` · ${new Intl.NumberFormat('fr-FR').format(data.votes)} notes` : '';
      return `<span class="rating">★ ${Number(data.rating).toLocaleString('fr-FR')}/5 AlloCiné${votes}</span>${data.url ? `<a href="${escapeHTML(data.url)}" target="_blank" rel="noreferrer">Détails ↗</a>` : ''}`;
    }
    if (data?.url) return `<a href="${escapeHTML(data.url)}" target="_blank" rel="noreferrer">Voir la fiche AlloCiné ↗</a>`;
    return state.requested.has(normalize(title)) ? '<span>Note AlloCiné indisponible</span>' : '<span>Recherche de la note…</span>';
  }

  function sessionMarkup(session) {
    const price = feeFor(session);
    const booked = Boolean(session.bookable && session.bookingUrl);
    const timeLink = booked
      ? `<a class="time-link" href="${escapeHTML(session.bookingUrl)}" target="_blank" rel="noreferrer" aria-label="Réserver ${escapeHTML(session.title)} à ${escapeHTML(session.time)} chez ${escapeHTML(session.cinemaName)}"><span>${escapeHTML(session.time)}</span><small>Réserver ↗</small></a>`
      : `<span class="time-link" aria-label="Réservation indisponible"><span>${escapeHTML(session.time)}</span><small>Indisponible</small></span>`;
    const room = session.room ? `<span>${escapeHTML(session.room)}</span>` : '';
    return `<div class="session-row">
      <div><div class="session-venue"><span class="venue-dot ${session.cinemaKey}"></span>${escapeHTML(cinemas[session.cinemaKey] || session.cinemaName)}</div><div class="session-label"><span class="format-label ${isPremium(session) ? '' : 'standard'}">${escapeHTML(session.format || 'Classique')}</span><span>${escapeHTML(session.version || 'VF')}</span>${room}</div></div>
      <div class="price ${isPremium(session) ? 'premium' : ''}">${escapeHTML(price)}</div>
      ${timeLink}
    </div>`;
  }

  function renderMovies() {
    const groups = groupsForDate();
    $('#movieCount').textContent = groups.length;
    $('#sessionCount').textContent = groups.reduce((count, movie) => count + movie.sessions.length, 0);
    $('#resultsSubtitle').textContent = state.cinema === 'all' ? 'Compare les horaires et les formats des deux cinémas' : `Les séances du ${cinemas[state.cinema]}`;
    const list = $('#movieList');
    if (state.loading && !state.sessions.length) {
      list.innerHTML = '<div class="empty"><strong>On récupère le programme…</strong><span>Les séances Pathé de Montpellier arrivent dans un instant.</span></div>';
      return;
    }
    if (!groups.length) {
      const message = state.error && !state.sessions.length ? 'La programmation Pathé est momentanément inaccessible.' : state.filter === 'favorites' ? 'Aucun film de ta liste à cette date.' : state.query ? 'Aucun film ne correspond à cette recherche.' : 'Aucune séance trouvée pour cette date.';
      list.innerHTML = `<div class="empty"><strong>${message}</strong><span>${state.error && !state.sessions.length ? 'Vérifie ta connexion et actualise le programme. Les horaires ne sont pas remplacés par des exemples.' : 'Essaie un autre jour ou enlève un filtre.'}</span></div>`;
      return;
    }
    list.innerHTML = groups.map(movie => {
      const enrichment = state.enrichment[normalize(movie.title)] || {};
      const poster = movie.posterUrl || enrichment.posterUrl || '';
      const duration = formatDuration(movie.duration);
      const genres = (movie.genres || []).filter(Boolean).join(' · ');
      const meta = [genres, duration].filter(Boolean).join(' · ') || 'Film à l’affiche';
      const synopsis = movie.synopsis ? `<div class="movie-synopsis">${escapeHTML(movie.synopsis)}</div>` : '';
      const posterImage = poster ? `<img src="${escapeHTML(poster)}" alt="Affiche de ${escapeHTML(movie.title)}" loading="lazy" onerror="this.remove()">` : '';
      return `<article class="movie-card">
        <div class="poster" aria-hidden="true">${posterImage}<span class="poster-title">${escapeHTML(movie.title)}</span></div>
        <div class="movie-body">
          <div class="movie-heading"><div><h3 class="movie-title">${escapeHTML(movie.title)}</h3><div class="movie-sub">${escapeHTML(meta)}</div><div class="movie-extra">${ratingMarkup(movie.title)}</div>${synopsis}</div><button class="fav-btn ${isWanted(movie.title) ? 'active' : ''}" data-fav="${escapeHTML(movie.title)}" type="button" aria-label="${isWanted(movie.title) ? 'Retirer' : 'Ajouter'} ${escapeHTML(movie.title)} ${isWanted(movie.title) ? 'de' : 'à'} ma liste" title="${isWanted(movie.title) ? 'Dans ma liste' : 'Ajouter à ma liste'}"><svg width="15" height="15" viewBox="0 0 24 24" fill="${isWanted(movie.title) ? 'currentColor' : 'none'}"><path d="m12 2.7 2.88 5.84 6.44.94-4.66 4.54 1.1 6.41L12 17.4l-5.76 3.03 1.1-6.41L2.68 9.48l6.44-.94L12 2.7Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg></button></div>
          <div class="sessions">${movie.sessions.sort((a,b) => a.time.localeCompare(b.time)).map(sessionMarkup).join('')}</div>
        </div>
      </article>`;
    }).join('');
    list.querySelectorAll('[data-fav]').forEach(button => button.addEventListener('click', () => {
      const title = button.dataset.fav;
      state.wanted = isWanted(title) ? state.wanted.filter(item => normalize(item) !== normalize(title)) : [...state.wanted, title];
      save();
    }));
    enrich(groups.map(movie => movie.title));
  }

  async function enrich(titles) {
    const queue = [...new Set(titles.map(title => title.trim()).filter(Boolean))].filter(title => !state.requested.has(normalize(title)));
    queue.forEach(title => state.requested.add(normalize(title)));
    let index = 0;
    const worker = async () => {
      while (index < queue.length) {
        const title = queue[index++];
        try {
          const response = await fetch(`/api/allocine?${new URLSearchParams({title})}`);
          const result = await response.json();
          state.enrichment[normalize(title)] = result;
        } catch {
          state.enrichment[normalize(title)] = { rating: null, url: `https://www.allocine.fr/rechercher/?${new URLSearchParams({q:title})}` };
        }
        renderMovies();
      }
    };
    await Promise.all(Array.from({length: Math.min(3, queue.length)}, worker));
  }

  async function fetchSchedule(force = false) {
    if (state.loading) return;
    state.loading = true; state.error = '';
    $('#refreshButton').disabled = true;
    $('#sourceMessage').textContent = 'Connexion aux horaires Pathé…';
    renderMovies();
    const from = localDate(dates[0]);
    const to = localDate(dates[dates.length - 1]);
    try {
      const parameters = new URLSearchParams({from, to});
      if (force) parameters.set('refresh', '1');
      const response = await fetch(`/api/showtimes?${parameters}`, { signal: AbortSignal.timeout(35000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Le programme Pathé ne répond pas.');
      state.sessions = data.sessions || [];
      state.error = '';
      const updated = data.updatedAt ? new Date(data.updatedAt) : new Date();
      $('#sourceMessage').textContent = `Séances Pathé actualisées à ${dateLabel(updated,{hour:'2-digit',minute:'2-digit'})} · clique sur une heure pour réserver.`;
      render();
    } catch (error) {
      state.error = error.message || 'Connexion au serveur local impossible.';
      $('#sourceMessage').textContent = `Impossible de charger Pathé : ${state.error}`;
      state.loading = false;
      renderMovies();
    } finally {
      state.loading = false;
      $('#refreshButton').disabled = false;
    }
  }

  function save() { localStorage.setItem('cineclub-wishlist', JSON.stringify(state.wanted)); render(); }
  function render() { renderDates(); renderWatchlist(); renderMovies(); }

  document.querySelectorAll('[data-cinema]').forEach(button => button.addEventListener('click', () => {
    state.cinema = button.dataset.cinema;
    document.querySelectorAll('[data-cinema]').forEach(item => item.classList.toggle('selected', item === button));
    renderMovies();
  }));
  document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('selected', item === button));
    renderMovies();
  }));
  $('#searchInput').addEventListener('input', event => { state.query = event.target.value.trim(); renderMovies(); });
  $('#addForm').addEventListener('submit', event => {
    event.preventDefault();
    const field = $('#addMovie');
    const title = field.value.trim();
    if (!title || isWanted(title)) { field.value = ''; return; }
    state.wanted = [...state.wanted, title]; field.value = ''; save();
  });
  $('#topListButton').addEventListener('click', () => {
    document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('selected', item.dataset.filter === 'favorites'));
    state.filter = 'favorites'; renderMovies();
    $('#seances').scrollIntoView({behavior:'smooth', block:'start'});
  });
  $('#refreshButton').addEventListener('click', () => fetchSchedule(true));
  render();
  fetchSchedule();
})();
