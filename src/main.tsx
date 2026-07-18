// Entry point — vanilla game, no React needed.
// Import game CSS, then initialize the game after DOM is ready.
import './game.css';
import { initGame } from './game';

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGame);
} else {
  initGame();
}
