import {
  auth, db, signInAnonymously, onAuthStateChanged,
  collection, doc, setDoc, getDoc, updateDoc, onSnapshot,
  serverTimestamp, increment, runTransaction, query, where, getDocs
} from './firebase';

// ==========================================
// VALIDATION DATA  (loaded once, never reloaded)
// ==========================================
const VALIDATION_DATA: {
  names: Set<string>;
  places: Set<string>;
  animals: Set<string>;
  things: Set<string>;
  loaded: boolean;
} = {
  names: new Set(),
  places: new Set(),
  animals: new Set(),
  things: new Set(),
  loaded: false,
};

// Mirror as arrays for AI random sampling
const AI_DATA: { names: string[]; places: string[]; animals: string[]; things: string[] } = {
  names: [],
  places: [],
  animals: [],
  things: [],
};

function normalizeWord(word: string): string {
  return word.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function loadAllDatasets() {
  if (VALIDATION_DATA.loaded) return;

  const datasets: Record<string, string[]> = {
    names:   ['data/names/india.json', 'data/names/international.json'],
    places:  [
      'data/places/countries.json', 'data/places/india-states.json',
      'data/places/union-teritories.json', 'data/places/indian-cities.json',
      'data/places/world-cities.json', 'data/places/famous-places.json',
    ],
    animals: [
      'data/animals/mammals.json', 'data/animals/birds.json',
      'data/animals/reptiles.json', 'data/animals/amphibians.json',
      'data/animals/insects.json', 'data/animals/marine.json',
    ],
    things: [
      'data/things/electronics.json', 'data/things/furniture.json',
      'data/things/stationary.json', 'data/things/vehicles.json',
      'data/things/food.json', 'data/things/sports.json',
      'data/things/musical.json', 'data/things/tools.json',
      'data/things/clothing.json', 'data/things/kitchen.json',
      'data/things/office-items.json', 'data/things/appliances.json',
      'data/things/household.json', 'data/things/toys.json',
      'data/things/miscellaneous.json',
    ],
  };

  for (const [category, files] of Object.entries(datasets)) {
    const set = VALIDATION_DATA[category as keyof typeof VALIDATION_DATA] as Set<string>;
    await Promise.all(
      files.map(async (file) => {
        try {
          const res = await fetch(file);
          if (!res.ok) return;
          const words: string[] = await res.json();
          // Store normalized for O(1) case-insensitive lookup
          for (const w of words) set.add(normalizeWord(w));
        } catch { /* silently skip missing files */ }
      })
    );
    AI_DATA[category as keyof typeof AI_DATA] = [...set];
  }

  VALIDATION_DATA.loaded = true;
}

// ==========================================
// SOLO MODE STATE
// ==========================================
let isSoloMode = false;
let aiTimeoutId: ReturnType<typeof setTimeout> | null = null;

interface SoloPlayer {
  id: string;
  name: string;
  score: number;
  hasSubmitted: boolean;
  isTyping: boolean;
  answers: Record<string, string>;
}

const soloGameState: {
  currentRound: number;
  currentLetter: string;
  state: string;
  players: Record<string, SoloPlayer>;
  roundHistory: unknown[];
  difficulty: string;
} = {
  currentRound: 0,
  currentLetter: '',
  state: 'lobby',
  players: {},
  roundHistory: [],
  difficulty: 'medium',
};

// ==========================================
// DOM REFERENCES  (resolved once on init)
// ==========================================
let screens: Record<string, HTMLElement>;
let sfxPencil: HTMLAudioElement;
let sfxPageTurn: HTMLAudioElement;
let sfxBell: HTMLAudioElement;
let btnCreateRoom: HTMLButtonElement;
let btnJoinRoom: HTMLButtonElement;
let inputPlayerName: HTMLInputElement;
let inputRoomCode: HTMLInputElement;
let displayRoomCode: HTMLElement;
let btnCopyCode: HTMLButtonElement;
let lobbyPlayerList: HTMLElement;
let playerCountDisplay: HTMLElement;
let btnReady: HTMLButtonElement;
let btnStartGame: HTMLButtonElement;
let currentRoundDisplay: HTMLElement;
let timerDisplay: HTMLElement;
let timerContainer: HTMLElement;
let spinnerOverlay: HTMLElement;
let btnStartSpinner: HTMLButtonElement;
let btnStopSpinner: HTMLButtonElement;
let btnSubmitRound: HTMLButtonElement;
let btnNextRound: HTMLButtonElement;
let btnEndGame: HTMLButtonElement;
let turnAnnouncement: HTMLElement;
let currentLetterDisplay: HTMLElement;
let displayLetter: HTMLElement;
let notebookRowsContainer: HTMLElement;
let challengeOverlay: HTMLElement;
let challengeList: HTMLElement;
let btnSkipChallenge: HTMLButtonElement;
let challengeTimerDisplay: HTMLElement;
let votingOverlay: HTMLElement;
let voteQuestion: HTMLElement;
let btnVoteYes: HTMLButtonElement;
let btnVoteNo: HTMLButtonElement;
let toast: HTMLElement;

// ==========================================
// GAME STATE
// ==========================================
let currentUser: import('firebase/auth').User | null = null;
let currentRoomId: string | null = null;
let isRoomCreator = false;
let myPlayerName = '';
let playersData: Record<string, { id: string; name: string; isReady: boolean; score: number; hasSubmitted: boolean; isTyping: boolean }> = {};
let roomData: Record<string, unknown> = {};
let currentRoundAnswers: Record<string, Record<string, string>> = {};
let authReady = false;

let hostTimerInterval: ReturnType<typeof setInterval> | null = null;
let alphabetInterval: ReturnType<typeof setInterval> | null = null;
let currentHighlight = 0;
const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const validationTimeouts: Record<string, ReturnType<typeof setTimeout>> = {};

let challengeTimerInterval: ReturnType<typeof setInterval> | null = null;
let votingTimerInterval: ReturnType<typeof setInterval> | null = null;
let localTimerInterval: ReturnType<typeof setInterval> | null = null;
let localTimer = 90;

// Performance: debounce isTyping=true writes per player (one write per typing burst, not per keystroke)
let typingWriteTimeout: ReturnType<typeof setTimeout> | null = null;
let lastTypingState = false;

// ==========================================
// HELPERS
// ==========================================
function showScreen(name: string) {
  Object.values(screens).forEach(s => {
    s.classList.remove('active');
    s.classList.add('hidden');
  });
  screens[name].classList.remove('hidden');
  screens[name].classList.add('active');

  const bb = document.getElementById('blackboard-container')!;
  name === 'game' ? bb.classList.remove('hidden') : bb.classList.add('hidden');
}

function showToast(message: string, type: 'normal' | 'error' | 'success' | 'warning' = 'normal') {
  toast.textContent = message;
  if (type === 'error') toast.style.borderColor = 'var(--text-pen)';
  else if (type === 'success') toast.style.borderColor = '#166534';
  else toast.style.borderColor = 'var(--text-pencil)';
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getAvatarLetter(name: string) {
  return name ? name.charAt(0).toUpperCase() : '?';
}

function getIsRoundHost() {
  if (!roomData || !currentUser) return false;
  return (roomData as Record<string, string>).currentRoundHostId === currentUser.uid;
}

function updateVisualValidation(input: HTMLInputElement, statusObj: { status: string }) {
  input.classList.remove('valid', 'invalid', 'warning');
  if (statusObj.status === 'valid') input.classList.add('valid');
  else if (statusObj.status === 'invalid') input.classList.add('invalid');
  else if (statusObj.status === 'warning') input.classList.add('warning');
}

// ==========================================
// VALIDATION
// ==========================================
async function validateWord(word: string, category: string): Promise<{ status: string; reason: string }> {
  if (word.length < 2) return { status: 'invalid', reason: 'Too short' };

  const norm = normalizeWord(word);

  // Fast O(1) Set lookups with normalized keys
  if (category === 'name'   && VALIDATION_DATA.names.has(norm))   return { status: 'valid', reason: 'Valid ✓' };
  if (category === 'place'  && VALIDATION_DATA.places.has(norm))  return { status: 'valid', reason: 'Valid ✓' };
  if (category === 'animal' && VALIDATION_DATA.animals.has(norm)) return { status: 'valid', reason: 'Valid ✓' };
  if (category === 'thing'  && VALIDATION_DATA.things.has(norm))  return { status: 'valid', reason: 'Valid ✓' };

  try {
    let isCommonWord = false;
    let meanings: Array<{ partOfSpeech: string; definitions: Array<{ definition: string }> }> = [];
    try {
      const dictRes = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      if (dictRes.ok) {
        const dictData = await dictRes.json();
        isCommonWord = true;
        meanings = dictData[0]?.meanings || [];
      }
    } catch { /* ignore */ }

    let combinedText = '';
    try {
      const wikiRes = await fetch(
        `https://en.wikipedia.org/w/api.php?action=query&prop=categories|extracts&exintro=1&titles=${encodeURIComponent(word)}&format=json&origin=*`
      );
      const wikiData = await wikiRes.json();
      const pages = wikiData.query.pages;
      const pageId = Object.keys(pages)[0];
      if (pageId !== '-1') {
        const cats = (pages[pageId].categories || []).map((c: { title: string }) => c.title.toLowerCase()).join(' ');
        const extract = (pages[pageId].extract || '').toLowerCase();
        combinedText = cats + ' ' + extract;
      }
    } catch { /* ignore */ }

    if (category === 'name') {
      if (/people|births|surname|given name|person/.test(combinedText)) return { status: 'valid', reason: 'Valid ✓' };
      if (isCommonWord) return { status: 'warning', reason: 'Uncommon name' };
      return { status: 'invalid', reason: 'Not recognised as a name' };
    }
    if (category === 'place') {
      if (/geography|cities|countries|places|settlements|towns|villages|district|capital|city|country/.test(combinedText))
        return { status: 'valid', reason: 'Valid ✓' };
      if (isCommonWord) return { status: 'warning', reason: 'Uncommon place' };
      return { status: 'invalid', reason: 'Not recognised as a place' };
    }
    if (category === 'animal') {
      if (/animal|birds|mammals|reptiles|fish|insects|species|fauna/.test(combinedText)) return { status: 'valid', reason: 'Valid ✓' };
      const isDictAnimal = meanings.some(m => m.definitions.some(d =>
        /animal|bird|fish/.test(d.definition.toLowerCase())
      ));
      if (isDictAnimal) return { status: 'valid', reason: 'Valid ✓' };
      if (isCommonWord) return { status: 'warning', reason: 'Uncommon animal' };
      return { status: 'invalid', reason: 'Not recognised as an animal' };
    }
    if (category === 'thing') {
      const isNoun = meanings.some(m => m.partOfSpeech === 'noun');
      if (isNoun && !/people|cities/.test(combinedText)) return { status: 'valid', reason: 'Valid ✓' };
      if (isCommonWord) return { status: 'warning', reason: 'Uncommon thing' };
      return { status: 'invalid', reason: 'Not recognised as a thing' };
    }

    return { status: 'invalid', reason: 'Invalid word' };
  } catch {
    return { status: 'warning', reason: 'Validation deferred to players' };
  }
}

// ==========================================
// SOLO MODE
// ==========================================
function startSoloGame() {
  isSoloMode = true;
  soloGameState.players = {
    player: { id: 'player', name: myPlayerName, score: 0, hasSubmitted: false, isTyping: false, answers: {} },
    ai1:    { id: 'ai1',    name: 'Alice (AI)', score: 0, hasSubmitted: false, isTyping: false, answers: {} },
  };
  soloGameState.currentRound = 1;
  soloGameState.state = 'spinner';

  document.getElementById('blackboard-container')!.classList.remove('hidden');
  showScreen('game');
  setupSoloAlphabetSelector();
}

function setupSoloAlphabetSelector() {
  generateAlphabetLetters();
  spinnerOverlay.classList.remove('hidden');
  document.getElementById('spinner-title')!.textContent = 'Choose the letter!';
  btnStartSpinner.classList.remove('hidden');
  btnStopSpinner.classList.add('hidden');

  const turnPopup = document.getElementById('turn-popup')!;
  turnPopup.classList.remove('hidden');
  setTimeout(() => turnPopup.classList.add('hidden'), 2000);
}

function generateAlphabetLetters() {
  const display = document.getElementById('alphabet-display')!;
  display.innerHTML = '';
  for (let i = 0; i < letters.length; i++) {
    const span = document.createElement('span');
    span.id = `alpha-${i}`;
    span.textContent = letters[i];
    display.appendChild(span);
  }
}

function startAIPlaying(letter: string) {
  soloGameState.players['ai1'].answers = { name: '', place: '', animal: '', thing: '' };
  soloGameState.players['ai1'].isTyping = false;
  soloGameState.players['ai1'].hasSubmitted = false;

  const thinkTime =
    soloGameState.difficulty === 'easy'   ? 10000 + Math.random() * 20000 :
    soloGameState.difficulty === 'medium' ?  5000 + Math.random() * 15000 :
                                             3000 + Math.random() *  7000;

  turnAnnouncement.textContent = '🤖 AI is thinking...';
  updateNotebookTableSolo();

  aiTimeoutId = setTimeout(() => {
    const aiAnswers = generateAIAnswers(letter);
    simulateTyping(aiAnswers, letter);
  }, thinkTime);
}

function generateAIAnswers(letter: string): Record<string, string> {
  const datasets: Record<string, string[]> = {
    name: AI_DATA.names, place: AI_DATA.places,
    animal: AI_DATA.animals, thing: AI_DATA.things,
  };
  const answers: Record<string, string> = { name: '', place: '', animal: '', thing: '' };

  for (const cat of ['name', 'place', 'animal', 'thing']) {
    const valid = datasets[cat].filter(w => w[0]?.toUpperCase() === letter.toUpperCase() && w.length >= 2);
    if (!valid.length) continue;
    if (soloGameState.difficulty === 'easy' && Math.random() < 0.1) continue;
    answers[cat] = valid[Math.floor(Math.random() * valid.length)];
  }
  return answers;
}

function simulateTyping(aiAnswers: Record<string, string>, _letter: string) {
  soloGameState.players['ai1'].isTyping = true;
  turnAnnouncement.textContent = '✏ AI is writing...';
  updateNotebookTableSolo();

  const cats = ['name', 'place', 'animal', 'thing'];
  let catIndex = 0;
  let charIndex = 0;
  let currentAnswer = aiAnswers[cats[catIndex]];

  function typeChar() {
    if (soloGameState.state !== 'playing') return;

    if (charIndex > currentAnswer.length) {
      catIndex++;
      if (catIndex >= cats.length) {
        soloGameState.players['ai1'].answers = { ...aiAnswers };
        soloGameState.players['ai1'].isTyping = false;
        soloGameState.players['ai1'].hasSubmitted = true;
        turnAnnouncement.textContent = 'Alice (AI) finished writing.';
        updateNotebookTableSolo();
        checkSoloAllSubmitted();
        return;
      }
      charIndex = 0;
      currentAnswer = aiAnswers[cats[catIndex]];
      setTimeout(typeChar, 200);
      return;
    }

    soloGameState.players['ai1'].answers[cats[catIndex]] = currentAnswer.substring(0, charIndex);
    updateNotebookTableSolo();
    charIndex++;
    setTimeout(typeChar, 50 + Math.random() * 150);
  }

  typeChar();
}

function checkSoloAllSubmitted() {
  if (soloGameState.players['player'].hasSubmitted && soloGameState.players['ai1'].hasSubmitted) {
    if (aiTimeoutId) { clearTimeout(aiTimeoutId); aiTimeoutId = null; }
    stopLocalTimer();
    calculateSoloScoresAndDisplay();
  }
}

function submitSoloAnswers() {
  if (soloGameState.players['player'].hasSubmitted) return;
  const myInputs = document.querySelectorAll<HTMLInputElement>('[data-player-id="player"]');
  const answers: Record<string, string> = {
    name:   myInputs[0].value.trim(),
    place:  myInputs[1].value.trim(),
    animal: myInputs[2].value.trim(),
    thing:  myInputs[3].value.trim(),
  };
  soloGameState.players['player'].answers = answers;
  soloGameState.players['player'].hasSubmitted = true;
  btnSubmitRound.disabled = true;
  btnSubmitRound.textContent = 'Submitted ✓';
  myInputs.forEach(i => (i.disabled = true));
  updateNotebookTableSolo();
  checkSoloAllSubmitted();
}

function calculateSoloScoresAndDisplay() {
  soloGameState.state = 'scoring';
  const letter = soloGameState.currentLetter;
  const cats = ['name', 'place', 'animal', 'thing'] as const;

  const answerGroups: Record<string, Record<string, string[]>> = { name: {}, place: {}, animal: {}, thing: {} };
  for (const player of Object.values(soloGameState.players)) {
    for (const cat of cats) {
      const val = player.answers[cat]?.trim().toLowerCase() || '';
      if (val && val[0].toUpperCase() === letter) {
        if (!answerGroups[cat][val]) answerGroups[cat][val] = [];
        answerGroups[cat][val].push(player.id);
      }
    }
  }

  const points: Record<string, Record<string, number>> = {};
  for (const pid of Object.keys(soloGameState.players)) {
    points[pid] = { name: 0, place: 0, animal: 0, thing: 0, total: 0 };
  }
  for (const cat of cats) {
    for (const [, pids] of Object.entries(answerGroups[cat])) {
      const score = pids.length === 1 ? 10 : 5;
      for (const pid of pids) { points[pid][cat] = score; points[pid].total += score; }
    }
  }

  soloGameState.roundHistory.push({
    roundNumber: soloGameState.currentRound,
    letter,
    players: Object.values(soloGameState.players).map(p => ({
      ...p, roundPoints: { ...points[p.id] },
      totalScoreAfterRound: p.score + points[p.id].total,
    })),
    timestamp: Date.now(),
  });

  for (const pid of Object.keys(soloGameState.players)) {
    soloGameState.players[pid].score += points[pid].total;
  }

  updateNotebookTableSolo();
  displayScoreStaggered(points, true);

  setTimeout(() => {
    btnNextRound.classList.remove('hidden');
    btnEndGame.classList.remove('hidden');
  }, 3000);
}

function updateNotebookTableSolo() {
  if (!notebookRowsContainer) return;
  const isScoring = soloGameState.state === 'scoring' || soloGameState.state === 'finished';

  // Build rows once — do NOT recreate on every call
  if (notebookRowsContainer.children.length === 0 && soloGameState.state !== 'lobby') {
    for (const player of Object.values(soloGameState.players)) {
      const row = document.createElement('div');
      row.className = 'game-row';
      row.id = `solo-player-row-${player.id}`;
      const isOwn = player.id === 'player';

      row.innerHTML = `
        <div class="row-letter" title="${player.name}">${getAvatarLetter(player.name)}</div>
        <div class="input-wrapper"><input type="text" data-player-id="${player.id}" data-category="name" ${!isOwn ? 'disabled' : ''}></div>
        <div class="input-wrapper"><input type="text" data-player-id="${player.id}" data-category="place" ${!isOwn ? 'disabled' : ''}></div>
        <div class="input-wrapper"><input type="text" data-player-id="${player.id}" data-category="animal" ${!isOwn ? 'disabled' : ''}></div>
        <div class="input-wrapper"><input type="text" data-player-id="${player.id}" data-category="thing" ${!isOwn ? 'disabled' : ''}></div>
        <div class="row-score" data-points-for="${player.id}"></div>
      `;
      notebookRowsContainer.appendChild(row);

      if (isOwn) {
        row.querySelectorAll<HTMLInputElement>('input').forEach(input => {
          input.addEventListener('input', (e) => {
            const target = e.target as HTMLInputElement;
            const val = target.value.trim();
            const cat = target.dataset.category!;
            const letter = soloGameState.currentLetter;
            soloGameState.players['player'].answers[cat] = val;

            if (validationTimeouts[cat]) clearTimeout(validationTimeouts[cat]);
            validationTimeouts[cat] = setTimeout(async () => {
              if (!val) updateVisualValidation(target, { status: 'empty' });
              else if (val[0].toUpperCase() !== letter) updateVisualValidation(target, { status: 'invalid' });
              else updateVisualValidation(target, await validateWord(val, cat));
              checkAllSoloInputsValid();
            }, 600);
          });
        });
      }
    }
  }

  // Update existing rows without destroying them
  for (const player of Object.values(soloGameState.players)) {
    const row = document.getElementById(`solo-player-row-${player.id}`);
    if (!row) continue;
    const isOwn = player.id === 'player';

    for (const cat of ['name', 'place', 'animal', 'thing']) {
      const input = row.querySelector<HTMLInputElement>(`input[data-category="${cat}"]`);
      if (!input) continue;
      input.placeholder = (!isScoring && !isOwn)
        ? (player.hasSubmitted ? 'Submitted ✓' : (player.isTyping ? 'Writing...' : 'Waiting...'))
        : cat.charAt(0).toUpperCase() + cat.slice(1);

      // Only reveal non-own answers once scoring begins — never during playing.
      if (isScoring) input.value = player.answers[cat] || '';
      else if (isOwn) { /* keep own input value as-is */ }
      else input.value = ''; // hide AI / other players' answers during playing
      input.disabled = !isOwn || player.hasSubmitted || isScoring;
    }
  }
}

function checkAllSoloInputsValid() {
  const myInputs = document.querySelectorAll<HTMLInputElement>('[data-player-id="player"]:not([disabled])');
  let hasInvalid = false;
  let allFilled = true;
  myInputs.forEach(i => {
    if (i.classList.contains('invalid')) hasInvalid = true;
    if (!i.value.trim()) allFilled = false;
  });
  btnSubmitRound.disabled = hasInvalid || !allFilled;
}

// ==========================================
// MULTIPLAYER — FIREBASE LISTENERS
// ==========================================
let unsubRoom: (() => void) | null = null;
let unsubPlayers: (() => void) | null = null;
let unsubRoundAnswers: (() => void) | null = null;

function cleanupListeners() {
  unsubRoom?.(); unsubRoom = null;
  unsubPlayers?.(); unsubPlayers = null;
  unsubRoundAnswers?.(); unsubRoundAnswers = null;
}

function listenToRoom() {
  unsubRoom = onSnapshot(doc(db, 'rooms', currentRoomId!), async (snap) => {
    if (!snap.exists()) {
      showToast('Room has been closed', 'error');
      showScreen('home');
      cleanupListeners();
      return;
    }
    const data = snap.data() as Record<string, unknown>;
    const oldState = (roomData as Record<string, string>).state || null;
    roomData = data;

    if (data.state === 'lobby') {
      isRoomCreator ? btnStartGame.classList.remove('hidden') : btnReady.classList.remove('hidden');
      isRoomCreator ? btnReady.classList.add('hidden') : btnStartGame.classList.add('hidden');
    } else if (data.state === 'spinner') {
      if (oldState !== 'spinner') {
        document.getElementById('blackboard-container')!.classList.remove('hidden');
        showScreen('game');
        setupAlphabetSelector();
        currentRoundDisplay.textContent = String(data.currentRound);
      }
      handleSpinnerState(data);
    } else if (data.state === 'playing') {
      spinnerOverlay.classList.add('hidden');
      currentLetterDisplay.classList.remove('hidden');
      displayLetter.textContent = String(data.currentLetter);

      if (oldState === 'spinner') {
        initializeNotebookTable();
        listenToRoundAnswers();
        btnSubmitRound.classList.remove('hidden');
        btnSubmitRound.disabled = false;
        btnSubmitRound.textContent = 'Submit Answers';
        btnNextRound.classList.add('hidden');
        btnEndGame.classList.add('hidden');
      }
      updateTimerDisplay(Number(data.timer));
    } else if (data.state === 'challenge') {
      stopHostTimer();
      btnSubmitRound.classList.add('hidden');
      if (oldState === 'playing') setupChallengePhase();
    } else if (data.state === 'voting') {
      challengeOverlay.classList.add('hidden');
      setupVotingPhase(String(data.currentVotingWord));
    } else if (data.state === 'scoring') {
      stopHostTimer();
      challengeOverlay.classList.add('hidden');
      votingOverlay.classList.add('hidden');
      btnSubmitRound.classList.add('hidden');
      if (oldState === 'playing' || oldState === 'challenge' || oldState === 'voting') {
        calculateAndDisplayScores();
        if (getIsRoundHost()) {
          setTimeout(async () => {
            if ((roomData as Record<string, string>).state === 'scoring') {
              await updateDoc(doc(db, 'rooms', currentRoomId!), {
                state: 'spinner',
                currentRound: increment(1),
                currentRoundHostId: getNextHostId(),
              });
            }
          }, 7000);
        }
      }
      if (getIsRoundHost()) {
        btnNextRound.classList.remove('hidden');
        btnEndGame.classList.remove('hidden');
      }
    } else if (data.state === 'finished') {
      try { sfxPageTurn.currentTime = 0; sfxPageTurn.play().catch(() => {}); } catch { /* ignore */ }
      setTimeout(() => { try { sfxBell.currentTime = 0; sfxBell.play().catch(() => {}); } catch { /* ignore */ } }, 1000);
      showLeaderboard();
    }
  });
}

function handleSpinnerState(data: Record<string, unknown>) {
  if (data.wheelSpinning) {
    if (alphabetInterval) clearInterval(alphabetInterval);
    alphabetInterval = setInterval(() => {
      document.querySelectorAll<HTMLElement>('.alphabet-display span').forEach(s => s.classList.remove('highlight', 'selected'));
      document.getElementById(`alpha-${currentHighlight}`)?.classList.add('highlight');
      currentHighlight = (currentHighlight + 1) % letters.length;
    }, 80);
  } else if (data.finalLetter !== undefined) {
    if (alphabetInterval) clearInterval(alphabetInterval);
    document.querySelectorAll<HTMLElement>('.alphabet-display span').forEach(s => s.classList.remove('highlight', 'selected'));
    const idx = letters.indexOf(String(data.finalLetter));
    if (idx >= 0) document.getElementById(`alpha-${idx}`)?.classList.add('selected');
  }
}

function listenToPlayers() {
  unsubPlayers = onSnapshot(collection(db, `rooms/${currentRoomId}/players`), (snapshot) => {
    playersData = {};
    lobbyPlayerList.innerHTML = '';
    let readyCount = 0;

    snapshot.forEach(docSnap => {
      const p = { id: docSnap.id, ...docSnap.data() } as typeof playersData[string];
      playersData[docSnap.id] = p;
      if (p.isReady) readyCount++;

      const li = document.createElement('li');
      li.className = `player-item ${p.id === (roomData as Record<string, string>).hostId ? 'host' : ''}`;
      li.innerHTML = `
        <div class="avatar">${getAvatarLetter(p.name)}</div>
        <div class="name">${p.name}</div>
        <div class="status ${p.isReady ? 'ready' : ''}"></div>
      `;
      lobbyPlayerList.appendChild(li);
    });

    playerCountDisplay.textContent = String(snapshot.size);

    if (isRoomCreator && (roomData as Record<string, string>).state === 'lobby') {
      btnStartGame.disabled = readyCount !== snapshot.size;
    }

    if (!isRoomCreator && currentUser && playersData[currentUser.uid]) {
      const isReady = playersData[currentUser.uid].isReady;
      btnReady.textContent = isReady ? 'Cancel Ready' : "I'm Ready";
      btnReady.classList.toggle('primary-btn', isReady);
      btnReady.classList.toggle('secondary-btn', !isReady);
    }

    updateTurnAnnouncement();

    const state = (roomData as Record<string, string>).state;
    if (state === 'playing' || state === 'scoring') updateNotebookTable();
  });
}

function updateTurnAnnouncement() {
  const state = (roomData as Record<string, string>).state;
  if (state === 'spinner') {
    const hostName = playersData[(roomData as Record<string, string>).currentRoundHostId]?.name || 'Someone';
    turnAnnouncement.textContent = getIsRoundHost()
      ? '🎯 It is your turn to stop the alphabet!'
      : `🎯 It is ${hostName}'s turn to stop the alphabet.`;
  } else if (state === 'playing') {
    let submitted = 0;
    const typists: string[] = [];
    const total = Object.keys(playersData).length;
    for (const p of Object.values(playersData)) {
      if (p.hasSubmitted) submitted++;
      else if (p.isTyping) typists.push(p.name);
    }
    const waiting = total - submitted;
    if (waiting <= 0) {
      turnAnnouncement.textContent = '✔ Everyone submitted!';
    } else if (typists.length > 0) {
      turnAnnouncement.textContent = `✏ ${typists.join(', ')} ${typists.length > 1 ? 'are' : 'is'} writing...`;
    } else if (submitted > 0) {
      turnAnnouncement.textContent = `⏳ Waiting for ${waiting} player${waiting > 1 ? 's' : ''}...`;
    } else {
      turnAnnouncement.textContent = '⏳ Waiting for players to start writing...';
    }
  }
}

function listenToRoundAnswers() {
  if (unsubRoundAnswers) { unsubRoundAnswers(); unsubRoundAnswers = null; }
  const round = (roomData as Record<string, number>).currentRound;
  unsubRoundAnswers = onSnapshot(
    collection(db, `rooms/${currentRoomId}/rounds/${round}/answers`),
    (snapshot) => {
      currentRoundAnswers = {};
      snapshot.forEach(d => { currentRoundAnswers[d.id] = d.data() as Record<string, string>; });

      if (getIsRoundHost() && (roomData as Record<string, string>).state === 'playing') {
        if (Object.values(playersData).every(p => p.hasSubmitted)) {
          updateDoc(doc(db, 'rooms', currentRoomId!), { state: 'scoring' });
        }
      }

      const state = (roomData as Record<string, string>).state;
      if (state === 'playing' || state === 'scoring') updateNotebookTable();
    }
  );
}

// ==========================================
// GAMEPLAY — SPINNER
// ==========================================
function setupAlphabetSelector() {
  generateAlphabetLetters();
  spinnerOverlay.classList.remove('hidden');
  const isRoundHost = getIsRoundHost();
  const hostName = playersData[(roomData as Record<string, string>).currentRoundHostId]?.name || 'someone';
  document.getElementById('spinner-title')!.textContent = isRoundHost
    ? 'Choose the letter!'
    : `Waiting for ${hostName} to choose…`;

  btnStartSpinner.classList.toggle('hidden', !isRoundHost);
  btnStopSpinner.classList.add('hidden');

  const turnPopup = document.getElementById('turn-popup')!;
  if (isRoundHost) {
    turnPopup.classList.remove('hidden');
    setTimeout(() => turnPopup.classList.add('hidden'), 2000);
  } else {
    turnPopup.classList.add('hidden');
  }
}

// ==========================================
// NOTEBOOK TABLE — MULTIPLAYER
// ==========================================
function initializeNotebookTable() {
  notebookRowsContainer.innerHTML = '';
  for (const player of Object.values(playersData)) {
    const row = document.createElement('div');
    row.className = 'game-row';
    row.id = `player-row-${player.id}`;
    const isOwn = player.id === currentUser?.uid;

    row.innerHTML = `
      <div class="row-letter" title="${player.name}">${getAvatarLetter(player.name)}</div>
      <div class="input-wrapper"><input type="text" data-player-id="${player.id}" data-category="name" placeholder="${!isOwn ? 'Writing...' : 'Name'}" ${!isOwn ? 'disabled' : ''}></div>
      <div class="input-wrapper"><input type="text" data-player-id="${player.id}" data-category="place" placeholder="${!isOwn ? 'Writing...' : 'Place'}" ${!isOwn ? 'disabled' : ''}></div>
      <div class="input-wrapper"><input type="text" data-player-id="${player.id}" data-category="animal" placeholder="${!isOwn ? 'Writing...' : 'Animal'}" ${!isOwn ? 'disabled' : ''}></div>
      <div class="input-wrapper"><input type="text" data-player-id="${player.id}" data-category="thing" placeholder="${!isOwn ? 'Writing...' : 'Thing'}" ${!isOwn ? 'disabled' : ''}></div>
      <div class="row-score" data-points-for="${player.id}"></div>
    `;
    notebookRowsContainer.appendChild(row);
  }
  setupInputListeners();
}

function setupInputListeners() {
  const myInputs = document.querySelectorAll<HTMLInputElement>(`[data-player-id="${currentUser?.uid}"]`);
  myInputs.forEach(input => {
    input.addEventListener('input', async (e) => {
      const target = e.target as HTMLInputElement;
      const val = target.value.trim();
      const cat = target.dataset.category!;
      const letter = (roomData as Record<string, string>).currentLetter;

      // Performance: debounce isTyping writes to avoid a Firestore write on every keystroke
      if (!lastTypingState) {
        lastTypingState = true;
        updateDoc(doc(db, `rooms/${currentRoomId}/players`, currentUser!.uid), { isTyping: true }).catch(() => {});
      }
      if (typingWriteTimeout) clearTimeout(typingWriteTimeout);
      typingWriteTimeout = setTimeout(() => {
        lastTypingState = false;
        updateDoc(doc(db, `rooms/${currentRoomId}/players`, currentUser!.uid), { isTyping: false }).catch(() => {});
      }, 600);

      if (validationTimeouts[cat]) clearTimeout(validationTimeouts[cat]);
      validationTimeouts[cat] = setTimeout(async () => {
        if (!val) updateVisualValidation(target, { status: 'empty' });
        else if (val[0].toUpperCase() !== letter) updateVisualValidation(target, { status: 'invalid' });
        else updateVisualValidation(target, await validateWord(val, cat));
        checkAllInputsValidMulti();
      }, 600);
    });
  });
}

function checkAllInputsValidMulti() {
  const myInputs = document.querySelectorAll<HTMLInputElement>(`[data-player-id="${currentUser?.uid}"]`);
  let hasInvalid = false;
  let allFilled = true;
  myInputs.forEach(i => {
    if (i.classList.contains('invalid')) hasInvalid = true;
    if (!i.value.trim()) allFilled = false;
  });
  btnSubmitRound.disabled = hasInvalid || !allFilled;
}

function updateNotebookTable() {
  if (!notebookRowsContainer) return;
  const state = (roomData as Record<string, string>).state;
  const isScoring = state === 'scoring' || state === 'finished';

  for (const player of Object.values(playersData)) {
    const row = document.getElementById(`player-row-${player.id}`);
    if (!row) continue;
    const answers = currentRoundAnswers[player.id] || {};
    const isOwn = player.id === currentUser?.uid;

    for (const cat of ['name', 'place', 'animal', 'thing']) {
      const input = row.querySelector<HTMLInputElement>(`input[data-category="${cat}"]`);
      if (!input) continue;
      input.placeholder = (!isScoring && !isOwn)
        ? (player.hasSubmitted ? 'Submitted ✓' : (player.isTyping ? 'Writing...' : 'Waiting...'))
        : cat.charAt(0).toUpperCase() + cat.slice(1);

      // Only reveal other players' answers once the room reaches scoring state.
      if (isScoring) input.value = answers[cat] || '';
      else if (!isOwn) input.value = ''; // keep hidden during playing
      input.disabled = !isOwn || player.hasSubmitted || isScoring;
    }
  }
}

// ==========================================
// TIMER
// ==========================================
function startHostTimer(initial: number) {
  let timeLeft = initial;
  if (hostTimerInterval) clearInterval(hostTimerInterval);
  hostTimerInterval = setInterval(async () => {
    timeLeft--;
    if (timeLeft <= 0 || Object.values(playersData).every(p => p.hasSubmitted)) {
      clearInterval(hostTimerInterval!);
      setTimeout(async () => {
        await updateDoc(doc(db, 'rooms', currentRoomId!), { state: 'challenge' });
      }, 1500);
    }
  }, 1000);
}

function stopHostTimer() {
  if (hostTimerInterval) { clearInterval(hostTimerInterval); hostTimerInterval = null; }
}

function startLocalTimer(duration: number) {
  localTimer = duration;
  updateTimerDisplay(duration);
  if (localTimerInterval) clearInterval(localTimerInterval);
  localTimerInterval = setInterval(() => {
    localTimer--;
    updateTimerDisplay(localTimer);
    if (localTimer <= 0) {
      clearInterval(localTimerInterval!);
      if (isSoloMode) {
        if (!soloGameState.players['player'].hasSubmitted) submitSoloAnswers();
        if (!soloGameState.players['ai1'].hasSubmitted) {
          if (aiTimeoutId) clearTimeout(aiTimeoutId);
          soloGameState.players['ai1'].isTyping = false;
          soloGameState.players['ai1'].hasSubmitted = true;
          updateNotebookTableSolo();
        }
        checkSoloAllSubmitted();
      } else {
        if (!playersData[currentUser?.uid ?? '']?.hasSubmitted) submitAnswers();
      }
    }
  }, 1000);
}

function stopLocalTimer() {
  if (localTimerInterval) { clearInterval(localTimerInterval); localTimerInterval = null; }
}

function updateTimerDisplay(time: number) {
  timerDisplay.textContent = String(time);
  timerContainer.className = 'timer-col';
  timerContainer.classList.add(time > 30 ? 'green' : time > 10 ? 'yellow' : 'red');
}

async function submitAnswers() {
  if (!currentUser || playersData[currentUser.uid]?.hasSubmitted) return;
  const myInputs = document.querySelectorAll<HTMLInputElement>(`[data-player-id="${currentUser.uid}"]`);
  const answers = {
    name:   myInputs[0].value.trim(),
    place:  myInputs[1].value.trim(),
    animal: myInputs[2].value.trim(),
    thing:  myInputs[3].value.trim(),
  };
  try {
    await setDoc(doc(db, `rooms/${currentRoomId}/rounds/${(roomData as Record<string, number>).currentRound}/answers`, currentUser.uid), answers);
    await updateDoc(doc(db, `rooms/${currentRoomId}/players`, currentUser.uid), { hasSubmitted: true, isTyping: false });
    btnSubmitRound.disabled = true;
    btnSubmitRound.textContent = 'Submitted ✓';
    myInputs.forEach(i => (i.disabled = true));
  } catch {
    showToast('Error submitting answers', 'error');
  }
}

// ==========================================
// CHALLENGE & VOTING
// ==========================================
function setupChallengePhase() {
  challengeOverlay.classList.remove('hidden');
  challengeList.innerHTML = '';

  const uniqueWords = new Set<string>();
  const letter = (roomData as Record<string, string>).currentLetter;
  Object.values(currentRoundAnswers).forEach(ans => {
    for (const cat of ['name', 'place', 'animal', 'thing']) {
      const w = ans[cat]?.trim();
      if (w && w[0].toUpperCase() === letter) uniqueWords.add(w.toLowerCase());
    }
  });

  uniqueWords.forEach(word => {
    const btn = document.createElement('button');
    btn.className = 'btn secondary-btn';
    btn.textContent = word;
    btn.style.margin = '5px';
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = `Challenged: ${word}`;
      await updateDoc(doc(db, `rooms/${currentRoomId}/rounds/${(roomData as Record<string, number>).currentRound}`), {
        [`challenges.${word}`]: true,
      });
    };
    challengeList.appendChild(btn);
  });

  if (getIsRoundHost()) {
    btnSkipChallenge.classList.remove('hidden');
    btnSkipChallenge.onclick = () => endChallengePhase();
    let timeLeft = 15;
    challengeTimerDisplay.textContent = String(timeLeft);
    if (challengeTimerInterval) clearInterval(challengeTimerInterval);
    challengeTimerInterval = setInterval(() => {
      timeLeft--;
      challengeTimerDisplay.textContent = String(timeLeft);
      if (timeLeft <= 0) endChallengePhase();
    }, 1000);
  } else {
    btnSkipChallenge.classList.add('hidden');
  }
}

async function endChallengePhase() {
  if (challengeTimerInterval) clearInterval(challengeTimerInterval);
  const round = (roomData as Record<string, number>).currentRound;
  const roundDoc = await getDoc(doc(db, `rooms/${currentRoomId}/rounds/${round}`));
  const challenges = (roundDoc.data()?.challenges || {}) as Record<string, boolean>;
  const challengedWords = Object.keys(challenges);

  if (challengedWords.length > 0) {
    await updateDoc(doc(db, 'rooms', currentRoomId!), {
      state: 'voting',
      pendingVotes: challengedWords,
      currentVotingWord: challengedWords[0],
    });
  } else {
    await updateDoc(doc(db, 'rooms', currentRoomId!), { state: 'scoring' });
  }
}

function setupVotingPhase(word: string) {
  votingOverlay.classList.remove('hidden');
  voteQuestion.textContent = `Is "${word}" a valid word?`;
  btnVoteYes.disabled = false;
  btnVoteNo.disabled = false;

  const round = (roomData as Record<string, number>).currentRound;
  btnVoteYes.onclick = async () => {
    btnVoteYes.disabled = true; btnVoteNo.disabled = true;
    await updateDoc(doc(db, `rooms/${currentRoomId}/rounds/${round}`), { [`votes.${word}.yes`]: increment(1) });
  };
  btnVoteNo.onclick = async () => {
    btnVoteYes.disabled = true; btnVoteNo.disabled = true;
    await updateDoc(doc(db, `rooms/${currentRoomId}/rounds/${round}`), { [`votes.${word}.no`]: increment(1) });
  };

  if (getIsRoundHost()) {
    let timeLeft = 10;
    if (votingTimerInterval) clearInterval(votingTimerInterval);
    votingTimerInterval = setInterval(async () => {
      timeLeft--;
      if (timeLeft <= 0) { clearInterval(votingTimerInterval!); await resolveCurrentVote(word); }
    }, 1000);
  }
}

async function resolveCurrentVote(word: string) {
  const round = (roomData as Record<string, number>).currentRound;
  const roundRef = doc(db, `rooms/${currentRoomId}/rounds/${round}`);
  const roundDoc = await getDoc(roundRef);
  const votes = (roundDoc.data()?.votes?.[word] || { yes: 0, no: 0 }) as { yes: number; no: number };
  let invalidWords: string[] = roundDoc.data()?.invalidWords || [];
  if (votes.no >= votes.yes && !invalidWords.includes(word)) invalidWords.push(word);
  await updateDoc(roundRef, { invalidWords });

  const roomRef = doc(db, 'rooms', currentRoomId!);
  const roomDoc = await getDoc(roomRef);
  const pendingVotes: string[] = roomDoc.data()?.pendingVotes || [];
  const nextVotes = pendingVotes.filter(w => w !== word);

  if (nextVotes.length > 0) {
    await updateDoc(roomRef, { pendingVotes: nextVotes, currentVotingWord: nextVotes[0] });
  } else {
    await updateDoc(roomRef, { state: 'scoring' });
  }
}

// ==========================================
// SCORING
// ==========================================
async function calculateAndDisplayScores() {
  const letter = (roomData as Record<string, string>).currentLetter;
  const cats = ['name', 'place', 'animal', 'thing'] as const;
  const round = (roomData as Record<string, number>).currentRound;

  const roundDoc = await getDoc(doc(db, `rooms/${currentRoomId}/rounds/${round}`));
  const invalidWords: string[] = roundDoc.data()?.invalidWords || [];

  const answerGroups: Record<string, Record<string, string[]>> = { name: {}, place: {}, animal: {}, thing: {} };
  for (const [pid, ansObj] of Object.entries(currentRoundAnswers)) {
    for (const cat of cats) {
      const val = ansObj[cat]?.trim().toLowerCase() || '';
      if (val && val[0].toUpperCase() === letter && !invalidWords.includes(val)) {
        if (!answerGroups[cat][val]) answerGroups[cat][val] = [];
        answerGroups[cat][val].push(pid);
      }
    }
  }

  const points: Record<string, Record<string, number>> = {};
  for (const pid of Object.keys(playersData)) points[pid] = { name: 0, place: 0, animal: 0, thing: 0, total: 0 };

  for (const cat of cats) {
    for (const [, pids] of Object.entries(answerGroups[cat])) {
      const score = pids.length === 1 ? 10 : 5;
      for (const pid of pids) { points[pid][cat] = score; points[pid].total += score; }
    }
  }

  if (getIsRoundHost()) {
    const roundRef = doc(db, `rooms/${currentRoomId}/rounds/${round}`);
    const freshDoc = await getDoc(roundRef);
    if (!freshDoc.exists() || !freshDoc.data().scored) {
      const writes = Object.entries(points)
        .filter(([, p]) => p.total > 0)
        .map(([pid, p]) =>
          updateDoc(doc(db, `rooms/${currentRoomId}/players`, pid), { score: increment(p.total) })
        );
      await Promise.all(writes);
      await setDoc(roundRef, { scored: true }, { merge: true });
    }
  }

  displayScoreStaggered(points, false);
}

function displayScoreStaggered(points: Record<string, Record<string, number>>, isSolo: boolean) {
  const cats = ['name', 'place', 'animal', 'thing'];
  const playerIds = isSolo ? Object.keys(soloGameState.players) : Object.keys(playersData);

  for (const pid of playerIds) {
    cats.forEach((cat, idx) => {
      setTimeout(() => {
        const score = points[pid]?.[cat];
        if (!score) return;
        const input = document.querySelector<HTMLElement>(`[data-player-id="${pid}"][data-category="${cat}"]`);
        if (!input?.parentElement) return;
        const badge = document.createElement('div');
        badge.className = 'answer-score-badge';
        badge.textContent = `+${score}`;
        input.parentElement.style.position = 'relative';
        input.parentElement.appendChild(badge);
      }, (idx + 1) * 500);
    });

    setTimeout(() => {
      const col = document.querySelector<HTMLElement>(`[data-points-for="${pid}"]`);
      if (col) col.textContent = String(points[pid]?.total ?? 0);
    }, 3000);
  }
}

// ==========================================
// HOST ROUND CONTROLS
// ==========================================
function getNextHostId(): string {
  const ids = Object.keys(playersData).sort();
  if (!ids.length) return currentUser!.uid;
  const cur = (roomData as Record<string, string>).currentRoundHostId;
  const idx = ids.indexOf(cur);
  return ids[(idx + 1) % ids.length];
}

// ==========================================
// LEADERBOARD
// ==========================================
function showLeaderboard() {
  showScreen('leaderboard');
  const sorted = Object.values(playersData).sort((a, b) => b.score - a.score);
  if (sorted.length) document.getElementById('champion-name')!.textContent = sorted[0].name;
  const marksRows = document.getElementById('marks-rows')!;
  marksRows.innerHTML = '';
  sorted.forEach((p, i) => {
    const prefix = i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : i === 2 ? '🥉 ' : '';
    const row = document.createElement('div');
    row.className = 'marks-row';
    row.innerHTML = `<div>${prefix}${p.name}</div><div class="highlight-red"><strong>${p.score}</strong></div><div>${(p as Record<string, number>).roundsWon || 0}</div><div>${(p as Record<string, number>).uniqueAnswers || 0}</div>`;
    marksRows.appendChild(row);
  });
}

function showSoloLeaderboard() {
  showScreen('leaderboard');
  const sorted = Object.values(soloGameState.players).sort((a, b) => b.score - a.score);
  if (sorted.length) document.getElementById('champion-name')!.textContent = sorted[0].name;
  const marksRows = document.getElementById('marks-rows')!;
  marksRows.innerHTML = '';
  sorted.forEach((p, i) => {
    const prefix = i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : '';
    const row = document.createElement('div');
    row.className = 'marks-row';
    row.innerHTML = `<div>${prefix}${p.name}</div><div class="highlight-red"><strong>${p.score}</strong></div><div></div><div></div>`;
    marksRows.appendChild(row);
  });
}

// ==========================================
// PUBLIC INIT
// ==========================================
export function initGame() {
  // Resolve DOM refs once
  screens = {
    home:        document.getElementById('home-screen')!,
    lobby:       document.getElementById('lobby-screen')!,
    game:        document.getElementById('game-screen')!,
    leaderboard: document.getElementById('leaderboard-screen')!,
  };
  sfxPencil  = document.getElementById('sfx-pencil')   as HTMLAudioElement;
  sfxPageTurn = document.getElementById('sfx-pageturn')  as HTMLAudioElement;
  sfxBell     = document.getElementById('sfx-bell')     as HTMLAudioElement;
  btnCreateRoom       = document.getElementById('btn-create-room')   as HTMLButtonElement;
  btnJoinRoom         = document.getElementById('btn-join-room')     as HTMLButtonElement;
  inputPlayerName     = document.getElementById('player-name-input') as HTMLInputElement;
  inputRoomCode       = document.getElementById('room-code-input')   as HTMLInputElement;
  displayRoomCode     = document.getElementById('display-room-code')!;
  btnCopyCode         = document.getElementById('btn-copy-code')     as HTMLButtonElement;
  lobbyPlayerList     = document.getElementById('lobby-player-list')!;
  playerCountDisplay  = document.getElementById('player-count')!;
  btnReady            = document.getElementById('btn-ready')         as HTMLButtonElement;
  btnStartGame        = document.getElementById('btn-start-game')    as HTMLButtonElement;
  currentRoundDisplay = document.getElementById('current-round-number')!;
  timerDisplay        = document.getElementById('timer-display')!;
  timerContainer      = document.getElementById('timer-container')!;
  spinnerOverlay      = document.getElementById('spinner-overlay')!;
  btnStartSpinner     = document.getElementById('btn-start-spinner') as HTMLButtonElement;
  btnStopSpinner      = document.getElementById('btn-stop-spinner')  as HTMLButtonElement;
  btnSubmitRound      = document.getElementById('btn-submit-round')  as HTMLButtonElement;
  btnNextRound        = document.getElementById('btn-next-round')    as HTMLButtonElement;
  btnEndGame          = document.getElementById('btn-end-game')      as HTMLButtonElement;
  turnAnnouncement    = document.getElementById('turn-announcement')!;
  currentLetterDisplay = document.getElementById('current-letter-display')!;
  displayLetter       = document.getElementById('display-letter')!;
  notebookRowsContainer = document.getElementById('notebook-rows-container')!;
  challengeOverlay    = document.getElementById('challenge-overlay')!;
  challengeList       = document.getElementById('challenge-list')!;
  btnSkipChallenge    = document.getElementById('btn-skip-challenge') as HTMLButtonElement;
  challengeTimerDisplay = document.getElementById('challenge-timer')!;
  votingOverlay       = document.getElementById('voting-overlay')!;
  voteQuestion        = document.getElementById('vote-question')!;
  btnVoteYes          = document.getElementById('btn-vote-yes')      as HTMLButtonElement;
  btnVoteNo           = document.getElementById('btn-vote-no')       as HTMLButtonElement;
  toast               = document.getElementById('toast')!;

  // Firebase auth
  onAuthStateChanged(auth, (user) => {
    if (user) {
      currentUser = user;
      authReady = true;
    } else {
      signInAnonymously(auth).catch(err => console.error('Sign-in error:', err));
    }
  });

  // Preload datasets in background
  loadAllDatasets();

  // ---- HOME BUTTONS ----
  document.getElementById('btn-solo')!.addEventListener('click', async () => {
    myPlayerName = inputPlayerName.value.trim();
    if (!myPlayerName) return showToast('Please enter your name', 'error');
    await loadAllDatasets(); // ensure loaded
    startSoloGame();
  });

  btnCreateRoom.addEventListener('click', async () => {
    myPlayerName = inputPlayerName.value.trim();
    if (!myPlayerName) return showToast('Please enter your name', 'error');
    if (!authReady || !currentUser) return showToast('Authenticating, please wait…', 'warning');

    const roomId = generateRoomCode();
    currentRoomId = roomId;
    isRoomCreator = true;
    try {
      await setDoc(doc(db, 'rooms', roomId), {
        hostId: currentUser.uid,
        currentRoundHostId: currentUser.uid,
        state: 'lobby',
        currentRound: 0,
        createdAt: serverTimestamp(),
        timer: 90,
      });
      await setDoc(doc(db, `rooms/${roomId}/players`, currentUser.uid), {
        name: myPlayerName, isReady: true, score: 0, hasSubmitted: false, isTyping: false,
      });
      joinRoomUI(roomId);
    } catch (err: unknown) {
      showToast('Error creating room: ' + (err as Error).message, 'error');
    }
  });

  btnJoinRoom.addEventListener('click', async () => {
    myPlayerName = inputPlayerName.value.trim();
    const roomId = inputRoomCode.value.trim().toUpperCase();
    if (!myPlayerName) return showToast('Please enter your name', 'error');
    if (!roomId)       return showToast('Please enter a room code', 'error');
    if (!authReady || !currentUser) return showToast('Authenticating, please wait…', 'warning');

    try {
      const snap = await getDoc(doc(db, 'rooms', roomId));
      if (!snap.exists()) return showToast('Room not found', 'error');
      const data = snap.data() as Record<string, string>;
      if (data.state !== 'lobby') return showToast('Game already in progress', 'error');

      currentRoomId = roomId;
      isRoomCreator = false;
      await setDoc(doc(db, `rooms/${roomId}/players`, currentUser.uid), {
        name: myPlayerName, isReady: false, score: 0, hasSubmitted: false, isTyping: false,
      });
      joinRoomUI(roomId);
    } catch (err: unknown) {
      showToast('Error joining room: ' + (err as Error).message, 'error');
    }
  });

  // ---- LOBBY ----
  btnCopyCode.addEventListener('click', () => {
    navigator.clipboard.writeText(currentRoomId!).then(() => showToast('Room code copied!', 'success'));
  });

  btnReady.addEventListener('click', async () => {
    if (!currentRoomId || !currentUser) return;
    const cur = playersData[currentUser.uid];
    await updateDoc(doc(db, `rooms/${currentRoomId}/players`, currentUser.uid), { isReady: !cur.isReady });
  });

  btnStartGame.addEventListener('click', async () => {
    if (!isRoomCreator) return;
    if (!Object.values(playersData).every(p => p.isReady)) return showToast('Not everyone is ready!', 'warning');
    const ids = Object.keys(playersData).sort();
    await updateDoc(doc(db, 'rooms', currentRoomId!), {
      state: 'spinner', currentRound: 1, timer: 90, currentRoundHostId: ids[0],
    });
  });

  // ---- SPINNER ----
  btnStartSpinner.addEventListener('click', async () => {
    if (isSoloMode) {
      btnStartSpinner.classList.add('hidden');
      btnStopSpinner.classList.remove('hidden');
      if (alphabetInterval) clearInterval(alphabetInterval);
      alphabetInterval = setInterval(() => {
        document.querySelectorAll<HTMLElement>('.alphabet-display span').forEach(s => s.classList.remove('highlight', 'selected'));
        document.getElementById(`alpha-${currentHighlight}`)?.classList.add('highlight');
        currentHighlight = (currentHighlight + 1) % letters.length;
      }, 80);
    } else if (getIsRoundHost()) {
      btnStartSpinner.classList.add('hidden');
      btnStopSpinner.classList.remove('hidden');
      await updateDoc(doc(db, 'rooms', currentRoomId!), { wheelSpinning: true, finalLetter: null });
    }
  });

  btnStopSpinner.addEventListener('click', async () => {
    if (isSoloMode) {
      btnStopSpinner.classList.add('hidden');
      if (alphabetInterval) clearInterval(alphabetInterval);
      const finalLetter = letters[currentHighlight];
      soloGameState.currentLetter = finalLetter;

      document.querySelectorAll<HTMLElement>('.alphabet-display span').forEach(s => s.classList.remove('highlight', 'selected'));
      document.getElementById(`alpha-${letters.indexOf(finalLetter)}`)?.classList.add('selected');

      setTimeout(() => {
        soloGameState.state = 'playing';
        spinnerOverlay.classList.add('hidden');
        currentLetterDisplay.classList.remove('hidden');
        displayLetter.textContent = finalLetter;
        currentRoundDisplay.textContent = String(soloGameState.currentRound);
        updateNotebookTableSolo();
        startLocalTimer(90);
        btnSubmitRound.classList.remove('hidden');
        btnSubmitRound.disabled = false;
        btnSubmitRound.textContent = 'Submit Answers';
        startAIPlaying(finalLetter);
      }, 1500);
    } else if (getIsRoundHost()) {
      btnStopSpinner.classList.add('hidden');
      const finalLetter = letters[currentHighlight];
      await updateDoc(doc(db, 'rooms', currentRoomId!), { wheelSpinning: false, finalLetter });
      setTimeout(async () => {
        await updateDoc(doc(db, 'rooms', currentRoomId!), {
          state: 'playing', currentLetter: finalLetter, timer: 90,
        });
        // Reset all players' submitted/typing state
        await Promise.all(Object.keys(playersData).map(pid =>
          updateDoc(doc(db, `rooms/${currentRoomId}/players`, pid), { hasSubmitted: false, isTyping: false })
        ));
        if (getIsRoundHost()) startHostTimer(90);
        startLocalTimer(90);
      }, 1500);
    }
  });

  // ---- SUBMIT ----
  btnSubmitRound.addEventListener('click', () => {
    isSoloMode ? submitSoloAnswers() : submitAnswers();
  });

  // ---- NEXT / END ----
  btnNextRound.addEventListener('click', async () => {
    if (isSoloMode) {
      soloGameState.currentRound++;
      soloGameState.state = 'spinner';
      soloGameState.players['player'].hasSubmitted = false;
      soloGameState.players['player'].answers = {};
      soloGameState.players['ai1'].hasSubmitted = false;
      soloGameState.players['ai1'].isTyping = false;
      soloGameState.players['ai1'].answers = {};
      if (aiTimeoutId) { clearTimeout(aiTimeoutId); aiTimeoutId = null; }
      btnNextRound.classList.add('hidden');
      btnEndGame.classList.add('hidden');
      btnSubmitRound.classList.add('hidden');
      notebookRowsContainer.innerHTML = '';
      setupSoloAlphabetSelector();
    } else {
      if (!getIsRoundHost()) return;
      await updateDoc(doc(db, 'rooms', currentRoomId!), {
        state: 'spinner', currentRound: increment(1), currentRoundHostId: getNextHostId(),
      });
    }
  });

  btnEndGame.addEventListener('click', async () => {
    if (isSoloMode) {
      showSoloLeaderboard();
    } else {
      if (!getIsRoundHost()) return;
      await updateDoc(doc(db, 'rooms', currentRoomId!), { state: 'finished' });
    }
  });

  document.getElementById('btn-play-again')!.addEventListener('click', () => window.location.reload());
}

function joinRoomUI(roomId: string) {
  cleanupListeners();
  displayRoomCode.textContent = roomId;
  showScreen('lobby');
  listenToRoom();
  listenToPlayers();
}
