/**
 * Live page for the four decks and their related tracks.
 *
 * `server.ts` sends this document for `GET /` and `GET /live`. The script
 * subscribes to `/events` and paints each deck from `related` messages.
 * Track text is assigned with `textContent`.
 */

/** HTML for the live related-tracks page. */
export const LIVE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Serato Listener</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 16px/1.4 system-ui, sans-serif; background: #121418; color: #f2f4f8; }
  main { padding: 20px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 0 0 8px; }
  p { margin: 0; }
  #status, #sidecar { color: #b7c0cc; font-size: 14px; }
  #sidecar { min-height: 1.2em; margin: 8px 0 16px; }
  .decks { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  .deck { background: #1c212b; border: 1px solid #2c3442; border-radius: 10px; padding: 12px; }
  .now { font-weight: 650; }
  .meta, .file { color: #9aa6b6; font-size: 13px; }
  .file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ol { margin: 10px 0 0; padding-left: 18px; }
  li { margin: 0 0 8px; }
  .saved { color: #9ddeb5; }
  .suggestion { color: #9ec0f0; }
  .empty { color: #9aa6b6; list-style: none; margin-left: -18px; }
</style>
</head>
<body>
<main>
  <h1>Now playing</h1>
  <p id="status">Waiting for Serato…</p>
  <p id="sidecar"></p>
  <div class="decks" id="decks"></div>
</main>
<script>
var decks = [0, 1, 2, 3].map(function (deck) {
  return {
    deck: deck,
    title: '',
    artist: '',
    filepath: '',
    key: '',
    bpm: null,
    matches: [],
    sidecar: '',
    error: ''
  };
});

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function banner() {
  var node = document.getElementById('sidecar');
  var error = '';
  var sidecar = '';
  decks.forEach(function (deck) {
    if (!error && deck.error) error = deck.error;
    if (!sidecar && deck.sidecar) sidecar = deck.sidecar;
  });
  if (error) node.textContent = error;
  else if (sidecar === 'missing') node.textContent = 'Saved relations file not found. Suggestions still show.';
  else if (sidecar === 'schema') node.textContent = 'Saved relations file has an unrecognized layout.';
  else if (sidecar === 'unavailable') node.textContent = 'Saved relations could not be read.';
  else node.textContent = '';
}

function render() {
  var root = document.getElementById('decks');
  root.replaceChildren();
  decks.forEach(function (deck) {
    var card = el('section', 'deck');
    card.appendChild(el('h2', null, 'Deck ' + (deck.deck + 1)));
    var title = deck.title || 'Nothing loaded';
    var heading = deck.artist ? title + ' — ' + deck.artist : title;
    card.appendChild(el('p', 'now', heading));
    var meta = [];
    if (deck.key) meta.push(deck.key);
    if (deck.bpm) meta.push(String(deck.bpm) + ' BPM');
    card.appendChild(el('p', 'meta', meta.join(' · ')));
    if (deck.filepath) card.appendChild(el('p', 'file', deck.filepath));
    var list = document.createElement('ol');
    if (!deck.matches.length) {
      list.appendChild(el('li', 'empty', 'No related tracks'));
    }
    deck.matches.forEach(function (match) {
      var item = document.createElement('li');
      var label = match.source === 'saved' ? 'Saved' : 'Suggestion';
      item.appendChild(el('div', null, (match.title || 'Untitled') + (match.artist ? ' — ' + match.artist : '')));
      item.appendChild(el('div', match.source === 'saved' ? 'saved' : 'suggestion', label));
      var bits = [];
      if (match.key) bits.push(match.key);
      if (match.bpm) bits.push(String(match.bpm) + ' BPM');
      if (match.crates && match.crates.length) bits.push(match.crates.join(', '));
      if (match.rating) bits.push(String(match.rating) + '/5');
      if (match.note) bits.push(match.note);
      if (bits.length) item.appendChild(el('div', 'meta', bits.join(' · ')));
      list.appendChild(item);
    });
    card.appendChild(list);
    root.appendChild(card);
  });
  banner();
}

function applyRelated(msg) {
  if (msg.deck == null || msg.deck < 0 || msg.deck > 3) return;
  var deck = decks[msg.deck];
  deck.title = msg.title || '';
  deck.artist = msg.artist || '';
  deck.filepath = msg.path || '';
  deck.key = msg.key || '';
  deck.bpm = msg.bpm;
  deck.matches = Array.isArray(msg.matches) ? msg.matches : [];
  deck.sidecar = msg.sidecar || '';
  deck.error = msg.error || '';
  render();
}

function applyTracks(tracks) {
  if (!Array.isArray(tracks)) return;
  tracks.forEach(function (track, index) {
    if (!track || !decks[index]) return;
    if (!decks[index].title) decks[index].title = track.title || '';
    if (!decks[index].artist) decks[index].artist = track.artist || '';
    if (track.filepath) decks[index].filepath = track.filepath;
  });
  render();
}

function setStatus(paired) {
  document.getElementById('status').textContent = paired ? 'Paired with Serato' : 'Waiting for Serato…';
}

var source = new EventSource('/events');
source.onopen = function () {
  document.getElementById('status').textContent = 'Connected';
};
source.onerror = function () {
  document.getElementById('status').textContent = 'Reconnecting…';
};
source.onmessage = function (event) {
  var msg;
  try {
    msg = JSON.parse(event.data);
  } catch (err) {
    return;
  }
  if (msg.type === 'snapshot') {
    setStatus(Boolean(msg.paired));
    applyTracks(msg.tracks);
    if (Array.isArray(msg.related)) msg.related.forEach(applyRelated);
  } else if (msg.type === 'related') {
    applyRelated(msg);
  } else if (msg.type === 'batch') {
    if (msg.paired != null) setStatus(Boolean(msg.paired));
    applyTracks(msg.tracks);
  } else if (msg.type === 'paired' || msg.type === 'connections') {
    if (msg.paired != null) setStatus(Boolean(msg.paired));
  }
};
render();
</script>
</body>
</html>
`;
